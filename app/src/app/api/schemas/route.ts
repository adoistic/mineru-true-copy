import { getTemplates, saveTemplate, deleteTemplate } from '@/lib/db/sqlite';

export async function GET() {
  try {
    const templates = await getTemplates();
    return Response.json({ templates });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch templates',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, description, schema, prompt } = body;

    if (!name || !schema) {
      return Response.json(
        { error: 'Missing required fields: name, schema' },
        { status: 400 }
      );
    }

    const template = await saveTemplate({
      name,
      description: description || '',
      schema,
      prompt: prompt || '',
    });

    return Response.json(template, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to save template',
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return Response.json(
        { error: 'Missing required query parameter: id' },
        { status: 400 }
      );
    }

    await deleteTemplate(id);
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to delete template',
      },
      { status: 500 }
    );
  }
}
