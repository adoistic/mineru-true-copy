import { checkHealth, getMineruStatus } from '@/lib/mineru/client';

export async function GET() {
  try {
    const [health, mineruStatus] = await Promise.all([
      checkHealth(),
      getMineruStatus(),
    ]);

    return Response.json({
      status: 'ok',
      app: health,
      processing_engine: mineruStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      {
        status: 'error',
        message: error instanceof Error ? error.message : 'Health check failed',
      },
      { status: 503 }
    );
  }
}
