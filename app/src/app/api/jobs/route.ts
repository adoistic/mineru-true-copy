import { getActiveJobs, getJob } from '@/lib/db/sqlite';
import { onJobProgress } from '@/lib/pipelines/runner';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const stream = searchParams.get('stream');

    if (stream === 'true') {
      if (!id) {
        return Response.json(
          { error: 'Missing required query parameter: id for streaming' },
          { status: 400 }
        );
      }

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          const unsubscribe = onJobProgress(id, (progress) => {
            const data = `data: ${JSON.stringify(progress)}\n\n`;
            controller.enqueue(encoder.encode(data));

            if (
              progress.status === 'completed' ||
              progress.status === 'failed'
            ) {
              controller.close();
              unsubscribe();
            }
          });

          request.signal.addEventListener('abort', () => {
            unsubscribe();
            controller.close();
          });
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (id) {
      const job = await getJob(id);

      if (!job) {
        return Response.json({ error: 'Job not found' }, { status: 404 });
      }

      return Response.json(job);
    }

    const jobs = await getActiveJobs();
    return Response.json({ jobs });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to fetch jobs',
      },
      { status: 500 }
    );
  }
}
