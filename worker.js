
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

      const cache = caches.default;
      const cacheKey = new Request(
        url.origin + "/api/jogos",
        { method: "GET" }
      );

      try {
        const cached = await cache.match(cacheKey);

        if (cached) {
          return cached;
        }

        const resposta = await fetch(
          "https://v3.football.api-sports.io/fixtures?live=all",
          {
            headers: {
              "x-apisports-key": env.API_FOOTBALL_KEY.trim()
            }
          }
        );

        const dados = await resposta.json();

        if (
          !resposta.ok ||
          Object.keys(dados.errors || {}).length > 0 ||
          !Array.isArray(dados.response)
        ) {
          return Response.json(dados, {
            status: dados.errors?.rateLimit ? 429 : 502,
            headers: {
              "Cache-Control": "no-store"
            }
          });
        }

        const resultado = Response.json(dados, {
          headers: {
            "Cache-Control": "public, max-age=90",
            "X-GOLSKY-Cache": "90s"
          }
        });

        try {
          await cache.put(cacheKey, resultado.clone());
        } catch (erro) {
          console.error("Erro no cache:", erro);
        }

        return resultado;

      } catch (erro) {
        return Response.json({
          erro: "Falha na consulta dos jogos"
        }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
