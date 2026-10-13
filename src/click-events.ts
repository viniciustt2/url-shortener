import { randomUUID } from 'node:crypto';
import { connect, type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage, type RecoveringChannelModel } from 'amqplib';
import type { Db } from 'mongodb';

export const clickQueueName = 'url-shortener.click-events';

type ClickEvent = {
    eventId: string;
    shortCode: string;
    clickedAt: string;
};

type OutboxEvent = ClickEvent & {
    _id: string;
    status: 'pending' | 'publishing' | 'published';
    createdAt: Date;
    retryAt: Date;
    attempts: number;
    leaseUntil?: Date;
    leaseOwner?: string;
    publishedAt?: Date;
};

export class MongoClickOutbox {
    private readonly db: Db;

    constructor(db: Db) {
        this.db = db;
    }

    async publish(event: ClickEvent): Promise<void> {
        await this.db.collection<OutboxEvent>('click_outbox').insertOne({
            ...event,
            _id: event.eventId,
            status: 'pending',
            createdAt: new Date(),
            retryAt: new Date(0),
            attempts: 0,
        });
    }
}

/** Records clicks directly for serverless deployments without a background worker. */
export class MongoClickEventWriter {
    private readonly db: Db;

    constructor(db: Db) {
        this.db = db;
    }

    async publish(event: ClickEvent): Promise<void> {
        await persistClickEvent(this.db, event);
    }
}

export async function persistClickEvent(db: Db, event: ClickEvent): Promise<void> {
    if (!event.eventId || !event.shortCode || !Number.isFinite(Date.parse(event.clickedAt))) {
        throw new Error('Malformed click event');
    }

    await db.collection<{ _id: string; shortCode: string; clickedAt: Date }>('click_events').updateOne(
        { _id: event.eventId },
        { $setOnInsert: { shortCode: event.shortCode, clickedAt: new Date(event.clickedAt) } },
        { upsert: true },
    );
}

export class RabbitClickQueue {
    private connection?: RecoveringChannelModel;
    private publisher?: ConfirmChannel;
    private consumer?: Channel;
    private ready = false;
    private stopping = false;
    private dispatcher?: Promise<void>;
    private readonly url: string;
    private readonly db: Db;

    constructor(url: string, db: Db) {
        this.url = url;
        this.db = db;
    }

    async start(): Promise<void> {
        this.stopping = false;
        this.dispatcher = this.dispatchOutbox();
        void this.connectUntilReady();
    }

    private async connectUntilReady(): Promise<void> {
        let delay = 500;
        while (!this.stopping && !this.connection) {
            try {
                const connection = await connect(this.url, {
                    recovery: {
                        waitForConnect: false,
                        initialDelay: 500,
                        maxDelay: 10_000,
                        maxRetries: Infinity,
                        setup: async (model: ChannelModel) => this.setupChannels(model),
                    },
                });
                if (this.stopping) {
                    await connection.close();
                    return;
                }
                this.connection = connection;
                connection.on('error', (error) => console.error('RabbitMQ connection error:', error));
                connection.on('disconnect', (error) => {
                    this.ready = false;
                    console.error('RabbitMQ disconnected; reconnecting:', error.message);
                });
                connection.on('reconnect-scheduled', ({ attempt, delay: retryDelay }) => {
                    console.warn(`RabbitMQ reconnect attempt ${attempt} in ${retryDelay}ms`);
                });
            } catch (error) {
                console.error(`Could not connect to RabbitMQ; retrying in ${delay}ms:`, error);
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, 10_000);
            }
        }
    }

    private async setupChannels(model: ChannelModel): Promise<void> {
        this.ready = false;
        const publisher = await model.createConfirmChannel();
        await publisher.assertQueue(clickQueueName, { durable: true });
        publisher.on('error', (error) => {
            this.ready = false;
            console.error('RabbitMQ publisher channel error:', error);
        });
        publisher.on('close', () => { this.ready = false; });

        const consumer = await model.createChannel();
        await consumer.assertQueue(clickQueueName, { durable: true });
        await consumer.prefetch(10);
        consumer.on('error', (error) => {
            this.ready = false;
            console.error('RabbitMQ consumer channel error:', error);
        });
        consumer.on('close', () => { this.ready = false; });
        await consumer.consume(clickQueueName, (message) => {
            if (message) void this.processMessage(consumer, message);
        }, { noAck: false });

        this.publisher = publisher;
        this.consumer = consumer;
        this.ready = true;
        console.log('RabbitMQ click queue and worker are ready');
    }

    private async processMessage(channel: Channel, message: ConsumeMessage): Promise<void> {
        try {
            const event = JSON.parse(message.content.toString('utf8')) as ClickEvent;
            if (message.properties.messageId !== event.eventId) {
                throw new Error('Click event messageId does not match its payload');
            }
            await persistClickEvent(this.db, event);
            channel.ack(message);
        } catch (error) {
            console.error('Could not process click event; requeueing:', error);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
                channel.nack(message, false, true);
            } catch (nackError) {
                console.error('Could not requeue click event:', nackError);
            }
        }
    }

    private async dispatchOutbox(): Promise<void> {
        const outbox = this.db.collection<OutboxEvent>('click_outbox');
        while (!this.stopping) {
            try {
                if (!this.ready || !this.publisher) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }

                const now = new Date();
                const leaseOwner = randomUUID();
                const event = await outbox.findOneAndUpdate(
                    {
                        $or: [
                            { status: 'pending', retryAt: { $lte: now } },
                            { status: 'publishing', leaseUntil: { $lte: now } },
                        ],
                    },
                    {
                        $set: {
                            status: 'publishing',
                            leaseUntil: new Date(now.getTime() + 30_000),
                            leaseOwner,
                        },
                        $inc: { attempts: 1 },
                    },
                    { sort: { createdAt: 1 }, returnDocument: 'after' },
                );

                if (!event) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }

                try {
                    await this.publishConfirmed(event);
                    await outbox.updateOne(
                        { _id: event._id, status: 'publishing', leaseOwner },
                        {
                            $set: { status: 'published', publishedAt: new Date() },
                            $unset: { leaseUntil: '', leaseOwner: '' },
                        },
                    );
                } catch (error) {
                    const backoffMs = Math.min(60_000, 1000 * (2 ** Math.min(event.attempts, 6)));
                    await outbox.updateOne(
                        { _id: event._id, status: 'publishing', leaseOwner },
                        {
                            $set: {
                                status: 'pending',
                                retryAt: new Date(Date.now() + backoffMs),
                                lastError: error instanceof Error ? error.message.slice(0, 500) : 'Unknown publish error',
                            },
                            $unset: { leaseUntil: '', leaseOwner: '' },
                        },
                    );
                    console.error(`Could not publish click event ${event._id}; retrying:`, error);
                }
            } catch (error) {
                console.error('Click outbox dispatcher failed; retrying:', error);
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }

    private async publishConfirmed(event: OutboxEvent): Promise<void> {
        const publisher = this.publisher;
        if (!this.ready || !publisher) throw new Error('RabbitMQ publisher is unavailable');
        await new Promise<void>((resolve, reject) => {
            try {
                publisher.sendToQueue(clickQueueName, Buffer.from(JSON.stringify({
                    eventId: event.eventId,
                    shortCode: event.shortCode,
                    clickedAt: event.clickedAt,
                })), {
                    persistent: true,
                    contentType: 'application/json',
                    messageId: event.eventId,
                }, (error) => error ? reject(error) : resolve());
            } catch (error) {
                reject(error);
            }
        });
    }

    async publish(event: Omit<ClickEvent, 'eventId'> & { eventId?: string }): Promise<void> {
        const completeEvent: ClickEvent = { ...event, eventId: event.eventId ?? randomUUID() };
        await new MongoClickOutbox(this.db).publish(completeEvent);
    }

    async check(): Promise<void> {
        if (!this.ready || !this.publisher || !this.consumer) {
            throw new Error('RabbitMQ click queue is not ready');
        }
        await this.publisher.checkQueue(clickQueueName);
        await this.consumer!.checkQueue(clickQueueName);
    }

    async close(): Promise<void> {
        this.stopping = true;
        this.ready = false;
        await this.connection?.close();
        await this.dispatcher;
    }
}
