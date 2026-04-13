import { getTranslationModels } from '@/lib/mineru/client';

export async function GET() {
  try {
    const models = await getTranslationModels();
    return Response.json(models);
  } catch {
    // Translation server not running — return offline status
    return Response.json({
      available: false,
      supported_languages: {},
      directions: [],
      variants: [],
      loaded: null,
    });
  }
}
