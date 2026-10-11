import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Shortly — links, made simple',
    description: 'Create reliable, memorable short links in seconds.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
