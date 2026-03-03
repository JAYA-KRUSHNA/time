'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { CheckCircle, XCircle } from 'lucide-react';

interface PendingFaculty { id: string; name: string; email: string; department: string; created_at: string; }

export default function ApprovalsPage() {
    const [pending, setPending] = useState<PendingFaculty[]>([]);
    const [loading, setLoading] = useState(true);

    const loadPending = async () => { const res = await fetch('/api/data?table=pending-faculty'); setPending(await res.json()); setLoading(false); };
    useEffect(() => { loadPending(); }, []);

    const handleAction = async (id: string, action: string) => {
        const res = await fetch('/api/admin/faculty-approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ faculty_id: id, action }) });
        if (res.ok) { toast.success(action === 'approve' ? 'Approved' : 'Rejected'); loadPending(); } else toast.error('Failed');
    };

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" style={{ width: 32, height: 32 }} /></div>;

    return (
        <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>Faculty Approvals</h1>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 24 }}>{pending.length} pending requests</p>

            {pending.length === 0
                ? <div className="glass" style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>No pending approvals</div>
                : <div style={{ display: 'grid', gap: 12 }}>
                    {pending.map((f, i) => (
                        <motion.div key={f.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="glass-card" style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <p style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>{f.name}</p>
                                <p style={{ fontSize: 13, color: '#64748b' }}>{f.email} · {f.department}</p>
                                <p style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>Applied {new Date(f.created_at).toLocaleDateString()}</p>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button onClick={() => handleAction(f.id, 'approve')} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.1)', color: '#22c55e', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle size={14} />Approve</button>
                                <button onClick={() => handleAction(f.id, 'reject')} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><XCircle size={14} />Reject</button>
                            </div>
                        </motion.div>
                    ))}
                </div>
            }
        </div>
    );
}
