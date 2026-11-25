
const CACHE_SECONDS = 300;
const BACKUP_SECONDS = 86400;
const RETRY_SECONDS = 120;
const TIMEZONE = "America/Sao_Paulo";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ESCUDOS DOS TIMES
    if (/^\/escudos\/\d+\.png$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop();

      try {
        const imagem = await fetch(
          "https://media.api-sports.io/football/teams/" + id
        );

        if (!imagem.ok) {
          return new Response("Escudo indisponivel", {
            status: 404
          });
        }

        return new Response(imagem.body, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400"
          }
        });
      } catch {
        return new Response("Falha ao carregar escudo", {
          status: 502
        });
      }
    }

    // STATUS DO SISTEMA
    if (url.pathname === "/api/status") {
      return Response.json({
        sistema: "GOLSKY",
        status: "online",
        apiConfigurada: Boolean(env.API_FOOTBALL_KEY),
        cacheSegundos: CACHE_SECONDS,
        timezone: TIMEZONE,
        modo: "jogos-do-dia"
      });
    }

    // CONSULTA DOS JOGOS
    if (url.pathname === "/api/jogos") {
      if (!env.API_FOOTBALL_KEY) {
        return Response.json({
          erro: "API nao configurada"
        }, { status: 503 });
      }

      const partes = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date());

      const obter = tipo =>
        partes.find(p => p.type === tipo).value;

      const hoje =
        obter("year") + "-" +
        obter("month") + "-" +
        obter("day");

      const cache = caches.default;

      const cacheKey = new Request(
        url.origin + "/api/cache-jogos/" + hoje
      );

      const backupKey = new Request(
        url.origin + "/api/cache-backup/" + hoje
      );

      const retryKey = new Request(
        url.origin + "/api/cache-retry/" + hoje
      );

      async function usarBackup() {
        const backup = await cache.match(backupKey);

        if (backup) {
          const dados = await backup.json();

          return Response.json({
            ...dados,
            golsky: {
              ...dados.golsky,
              desatualizado: true,
              aviso: "Exibindo ultima consulta disponivel"
            }
          }, {
            headers: {
              "Cache-Control": "no-store",
              "X-GOLSKY-Cache": "BACKUP"
            }
          });
        }

        return Response.json({
          erro: "Atualizacao temporariamente indisponivel",
          response: []
        }, {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(RETRY_SECONDS)
          }
        });
      }

      try {
        const cached = await cache.match(cacheKey);

        if (cached) {
          return cached;
        }

        const bloqueio = await cache.match(retryKey);

        if (bloqueio) {
          return await usarBackup();
        }

        const apiUrl = new URL(
          "https://v3.football.api-sports.io/fixtures"
        );

        apiUrl.searchParams.set("date", hoje);
        apiUrl.searchParams.set("timezone", TIMEZONE);

        const resposta = await fetch(apiUrl.toString(), {
          headers: {
            "x-apisports-key":
              env.API_FOOTBALL_KEY.trim()
          }
        });

        const dados = await resposta.json();

        if (
          !resposta.ok ||
          Object.keys(dados.errors || {}).length > 0 ||
          !Array.isArray(dados.response)
        ) {
          return Response.json({erro:"Falha na API",statusAPI:resposta.status,detalhes:dados.errors,parametros:dados.parameters},{status:502,headers:{"Cache-Control":"no-store"}});
        }

        dados.golsky = {
          atualizadoEm: new Date().toISOString(),
          desatualizado: false,
          data: hoje,
          timezone: TIMEZONE
        };

        const resultado = Response.json(dados, {
          headers: {
            "Cache-Control":
              "public, max-age=" + CACHE_SECONDS,
            "X-GOLSKY-Cache": "FRESH"
          }
        });

        const backup = Response.json(dados, {
          headers: {
            "Cache-Control":
              "public, max-age=" + BACKUP_SECONDS
          }
        });

        await Promise.allSettled([
          cache.put(cacheKey, resultado.clone()),
          cache.put(backupKey, backup)
        ]);

        return resultado;

      } catch (erro) {
        console.error("GOLSKY:", erro.message);

        try {
          await cache.put(
            retryKey,
            new Response("aguarde", {
              headers: {
                "Cache-Control":
                  "public, max-age=" + RETRY_SECONDS
              }
            })
          );
        } catch {}

        return await usarBackup();
      }
    }

    // SITE PRINCIPAL
    return env.ASSETS.fetch(request);
  }
};
