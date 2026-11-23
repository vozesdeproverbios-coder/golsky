export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return Response.json({
        sistema: "GOLSKY",
        status: "online",
        apiConfigurada: Boolean(env.API_FOOTBALL_KEY)
      });
    }

    return env.ASSETS.fetch(request);
  }
};
