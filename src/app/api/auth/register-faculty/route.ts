import { NextRequest, NextResponse } from 'next/server';
import { getDb, uuid } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { generateOTP, sendOTPEmail } from '@/lib/email';

export async function POST(request: NextRequest) {
    try {
        const { name, email, password, department } = await request.json();
        if (!name || !email || !password) return NextResponse.json({ error: 'All fields required' }, { status: 400 });

        const db = getDb();
        const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email);
        if (existing) return NextResponse.json({ error: 'Email already registered' }, { status: 409 });

        const hash = await hashPassword(password);
        const id = uuid();
        // Set status to 'unverified' — will become 'pending' (awaiting admin) after OTP verification
        db.prepare('INSERT INTO profiles (id, role, name, email, password, department, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            id, 'faculty', name, email, hash, department || 'CSE', 'unverified'
        );

        // Send OTP for email verification
        db.prepare("DELETE FROM otp_codes WHERE email = ? AND purpose = 'verification'").run(email);
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO otp_codes (id, email, code, purpose, attempts, max_attempts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            uuid(), email, otp, 'verification', 0, 3, expiresAt
        );
        await sendOTPEmail(email, otp, name);

        return NextResponse.json({ success: true, email, message: 'OTP sent for verification' });
    } catch (error) {
        console.error('Faculty register error:', error);
        return NextResponse.json({ error: 'Registration failed' }, { status: 500 });
    }
}
