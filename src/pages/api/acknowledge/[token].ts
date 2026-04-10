import type { APIRoute } from 'astro';
import { createServiceClient } from '../../../lib/supabase-server';

export const POST: APIRoute = async ({ params, request }) => {
  const { token } = params;
  const serviceClient = createServiceClient();

  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : null;
  const ua = request.headers.get('user-agent');

  const { data: dist, error } = await serviceClient
    .from('distributions')
    .select('id, acknowledged_at')
    .eq('token', token)
    .single();

  if (error || !dist) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (dist.acknowledged_at) {
    return new Response(JSON.stringify({ ok: true, already: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { error: updateErr } = await serviceClient
    .from('distributions')
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_ip: ip,
      acknowledged_ua: ua,
    })
    .eq('id', dist.id);

  if (updateErr) {
    return new Response(JSON.stringify({ error: updateErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
