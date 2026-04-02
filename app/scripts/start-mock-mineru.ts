import { startMockMineruServer } from '../src/lib/mineru/mock-server';

const port = parseInt(process.env.MINERU_PORT || '8765', 10);
startMockMineruServer(port);
