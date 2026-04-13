import { loadTranslationModel } from '@/lib/mineru/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const direction = body.direction ?? 'en-indic';
    const variant = body.variant ?? '1B';

    await loadTranslationModel(direction, variant);

    return Response.json({
      status: 'loaded',
      direction,
      variant,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Model load failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
