import { checkTranslationHealth } from '@/lib/mineru/client';

export async function GET() {
  try {
    const healthy = await checkTranslationHealth();
    return Response.json(
      { status: healthy ? 'ok' : 'offline' },
      { status: healthy ? 200 : 503 }
    );
  } catch {
    return Response.json({ status: 'offline' }, { status: 503 });
  }
}
