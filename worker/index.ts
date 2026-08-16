const API_UNAVAILABLE_MESSAGE =
  'The dashboard API is not on this Worker. PartnerDex metrics run in the Node process (npm start, or Fly.io in DEPLOY.md).';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/')) {
      return Response.json({ error: API_UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
