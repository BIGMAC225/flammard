import type { APIRoute } from 'astro';
import { endSession } from '../../../lib/auth';

export const POST: APIRoute = async ({ cookies, redirect }) => {
  endSession(cookies);
  return redirect('/login');
};
