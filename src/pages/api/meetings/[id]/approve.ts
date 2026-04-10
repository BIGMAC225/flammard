import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';
import { hashMinutes } from '../../../../lib/crypto';
import { generateMinutesPDF } from '../../../../lib/pdf';
import type { Attendee } from '../../../../types';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = params;

  // Load meeting + minutes
  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, title, date, location, attendees, created_by')
    .eq('id', id)
    .single();

  if (!meeting || meeting.created_by !== user.id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data: minutes } = await supabase
    .from('minutes')
    .select('id, summary, decisions, actions, discussion')
    .eq('meeting_id', id)
    .single();

  if (!minutes) {
    return new Response(JSON.stringify({ error: 'No minutes to approve' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const approvedAt = new Date().toISOString();
  const approverEmail = user.email ?? user.id;

  // Compute hash
  const hash = await hashMinutes({
    summary: minutes.summary,
    decisions: minutes.decisions,
    actions: minutes.actions,
    discussion: minutes.discussion,
  });

  // Generate PDF
  const pdfBuffer = await generateMinutesPDF({
    title: meeting.title,
    date: meeting.date,
    location: meeting.location,
    attendees: (meeting.attendees as Attendee[]) ?? [],
    summary: minutes.summary,
    decisions: minutes.decisions,
    actions: minutes.actions,
    discussion: minutes.discussion,
    hash,
    approvedBy: approverEmail,
    approvedAt,
    appName: import.meta.env.PUBLIC_APP_NAME || 'Flammard',
  });

  // Store PDF in Supabase Storage
  const pdfPath = `minutes/${id}/${hash.slice(0, 8)}.pdf`;
  await supabase.storage.from('minutes-pdf').upload(pdfPath, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: true,
  });

  // Seal the minutes
  await supabase
    .from('minutes')
    .update({
      content_hash: hash,
      sealed_at: approvedAt,
      sealed_by: user.id,
      pdf_path: pdfPath,
    })
    .eq('id', minutes.id);

  // Record approval
  await supabase.from('approvals').insert({
    minutes_id: minutes.id,
    approved_by: user.id,
    approved_by_email: approverEmail,
    hash_at_approval: hash,
  });

  // Update meeting status
  await supabase.from('meetings').update({ status: 'approved' }).eq('id', id);

  return new Response(JSON.stringify({ hash, approvedAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
