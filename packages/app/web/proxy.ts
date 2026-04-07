import { type NextRequest, NextResponse } from 'next/server';

export default function (_request: NextRequest) {
  const response = NextResponse.next();

  response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  return response;
}
