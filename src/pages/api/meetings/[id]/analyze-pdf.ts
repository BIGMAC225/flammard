import type { APIRoute } from 'astro';
import { createRequire } from 'module';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';
import { analyzeEOSDocument } from '../../../../lib/claude';

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

  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, created_by')
    .eq('id', id)
    .single();

  if (!meeting || meeting.created_by !== user.id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse multipart form data
  let pdfBuffer: Buffer;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return new Response(JSON.stringify({ error: 'No file uploaded' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return new Response(JSON.stringify({ error: 'File must be a PDF' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const arrayBuffer = await file.arrayBuffer();
    pdfBuffer = Buffer.from(arrayBuffer);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to read uploaded file' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract text from PDF using pdf-parse (CJS module via createRequire)
  let pdfText: string;
  try {
    const require = createRequire(import.meta.url);
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(pdfBuffer);
    pdfText = parsed.text;
    if (!pdfText || pdfText.trim().length < 50) {
      return new Response(
        JSON.stringify({ error: 'Could not extract readable text from this PDF. Please paste the content manually.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (err) {
    console.error('pdf-parse error:', err);
    return new Response(
      JSON.stringify({ error: 'PDF text extraction failed. Please paste your meeting content manually.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Analyze with Claude
  let analysis;
  try {
    analysis = await analyzeEOSDocument(pdfText);
  } catch (err) {
    console.error('Claude analysis error:', err);
    return new Response(JSON.stringify({ error: 'AI analysis failed. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Save analysis results to database
  try {
    // Update meeting metadata
    const meetingUpdate: Record<string, unknown> = { eos_analyzed: true };
    if (analysis.meeting_rating != null) meetingUpdate.meeting_rating = analysis.meeting_rating;
    if (analysis.conclude_notes) meetingUpdate.conclude_notes = analysis.conclude_notes;
    if (analysis.attendees?.length > 0) meetingUpdate.attendees = analysis.attendees;

    await supabase.from('meetings').update(meetingUpdate).eq('id', id);

    // Headlines
    if (analysis.headlines.length > 0) {
      await supabase.from('headlines').delete().eq('meeting_id', id);
      await supabase.from('headlines').insert(
        analysis.headlines.map((h) => ({
          meeting_id: id,
          type: h.type,
          text: h.text,
          presenter: h.presenter ?? null,
          created_by: user.id,
        }))
      );
    }

    // Rocks (create top-level rocks + meeting review entries)
    if (analysis.rocks.length > 0) {
      await supabase.from('meeting_rocks').delete().eq('meeting_id', id);
      for (const r of analysis.rocks) {
        // Upsert a top-level rock
        const { data: existingRock } = await supabase
          .from('rocks')
          .select('id')
          .eq('title', r.title)
          .eq('created_by', user.id)
          .maybeSingle();

        let rockId = existingRock?.id;
        if (!rockId) {
          const { data: newRock } = await supabase
            .from('rocks')
            .insert({
              title: r.title,
              owner: r.owner ?? null,
              status: r.status,
              notes: r.notes ?? null,
              created_by: user.id,
            })
            .select('id')
            .single();
          rockId = newRock?.id;
        } else {
          // Update status on existing rock
          await supabase
            .from('rocks')
            .update({ status: r.status, owner: r.owner ?? null })
            .eq('id', rockId);
        }

        // Meeting rock review entry
        await supabase.from('meeting_rocks').insert({
          meeting_id: id,
          rock_id: rockId ?? null,
          title: r.title,
          owner: r.owner ?? null,
          status: r.status,
          notes: r.notes ?? null,
          created_by: user.id,
        });
      }
    }

    // New to-dos created at this meeting
    if (analysis.todos_new.length > 0) {
      await supabase.from('todos').insert(
        analysis.todos_new.map((t) => ({
          meeting_id: id,
          title: t.title,
          owner: t.owner ?? null,
          status: 'open' as const,
          created_by: user.id,
        }))
      );
    }

    // Issues solved at this meeting
    if (analysis.issues_solved.length > 0) {
      await supabase.from('issues').insert(
        analysis.issues_solved.map((iss) => ({
          meeting_id: id,
          title: iss.title,
          resolution: iss.resolution ?? null,
          status: 'solved' as const,
          resolved_in_meeting_id: id,
          priority: 'medium' as const,
          created_by: user.id,
        }))
      );
    }

    // New issues raised
    if (analysis.issues_new.length > 0) {
      await supabase.from('issues').insert(
        analysis.issues_new.map((iss) => ({
          meeting_id: id,
          title: iss.title,
          description: iss.description ?? null,
          priority: iss.priority ?? 'medium',
          status: 'open' as const,
          created_by: user.id,
        }))
      );
    }

    // Scorecard
    if (analysis.scorecard.length > 0) {
      for (const sc of analysis.scorecard) {
        // Find or create the metric
        const { data: existingMetric } = await supabase
          .from('scorecard_metrics')
          .select('id')
          .eq('title', sc.title)
          .eq('created_by', user.id)
          .maybeSingle();

        let metricId = existingMetric?.id;
        if (!metricId) {
          const { data: newMetric } = await supabase
            .from('scorecard_metrics')
            .insert({
              title: sc.title,
              owner: sc.owner ?? null,
              goal: sc.goal ?? null,
              created_by: user.id,
            })
            .select('id')
            .single();
          metricId = newMetric?.id;
        }

        if (metricId) {
          await supabase
            .from('scorecard_entries')
            .upsert({
              metric_id: metricId,
              meeting_id: id,
              value: sc.value ?? null,
              on_track: sc.on_track ?? null,
              created_by: user.id,
            }, { onConflict: 'metric_id,meeting_id' });
        }
      }
    }

    // Mark meeting as having content for minutes drafting
    if (analysis.summary) {
      await supabase
        .from('meetings')
        .update({ status: 'draft' })
        .eq('id', id)
        .eq('status', 'draft');
    }
  } catch (err) {
    console.error('DB save error:', err);
    // Return analysis even if save partially failed
    return new Response(
      JSON.stringify({ analysis, warning: 'Analysis complete but some data may not have saved.' }),
      { status: 207, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ analysis }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
