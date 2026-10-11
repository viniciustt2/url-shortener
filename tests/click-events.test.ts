import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from 'mongodb';
import { MongoClickOutbox, persistClickEvent } from '../src/click-events.ts';

test('persists click events idempotently by event ID', async () => {
    const persisted = new Map<string, { shortCode: string; clickedAt: Date }>();
    const db = {
        collection: (name: string) => {
            assert.equal(name, 'click_events');
            return {
                updateOne: async (
                    filter: { _id: string },
                    update: { $setOnInsert: { shortCode: string; clickedAt: Date } },
                ) => {
                    if (!persisted.has(filter._id)) persisted.set(filter._id, update.$setOnInsert);
                    return { upsertedCount: 1 };
                },
            };
        },
    } as unknown as Db;
    const event = {
        eventId: 'stable-event-id',
        shortCode: 'abc123',
        clickedAt: '2026-10-09T00:00:00.000Z',
    };

    await persistClickEvent(db, event);
    await persistClickEvent(db, event);

    assert.equal(persisted.size, 1);
    assert.equal(persisted.get('stable-event-id')?.shortCode, 'abc123');
});

test('writes a pending event to MongoDB outbox before returning', async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
        collection: (name: string) => {
            assert.equal(name, 'click_outbox');
            return { insertOne: async (document: Record<string, unknown>) => { inserted = document; } };
        },
    } as unknown as Db;
    const outbox = new MongoClickOutbox(db);
    const event = {
        eventId: 'outbox-event-id',
        shortCode: 'abc123',
        clickedAt: '2026-10-09T00:00:00.000Z',
    };

    await outbox.publish(event);

    assert.equal(inserted?._id, event.eventId);
    assert.equal(inserted?.status, 'pending');
    assert.equal(inserted?.shortCode, event.shortCode);
});
