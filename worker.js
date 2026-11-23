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

    if (url.pathname === "/api/jogos") {
      if (!env.API_FOOTBALL_KEY) {
        return Response.json({
          erro: "API nao configurada"
        }, { status: 503 });
      }

      try {
        const resposta = await fetch(
          "https://v3.football.api-sports.io/fixtures?live=all",
          {
            headers: {
              "x-apisports-key": env.API_FOOTBALL_KEY.trim()
            }
          }
        );

        const dados = await resposta.json();

        return Response.json(dados, {
          status: resposta.status
        });
      } catch {
        return Response.json({
          erro: "Falha na consulta dos jogos"
        }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
