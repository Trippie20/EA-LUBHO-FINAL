import { handle } from '../../src/handler.js';

export const onRequest = ({ request, env }) => handle(request, env);
