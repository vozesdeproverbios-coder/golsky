
const CACHE_SECONDS = 300;
const BACKUP_SECONDS = 86400;
const RETRY_SECONDS = 120;
const EVENTS_CACHE_SECONDS = 300;
const FUTURE_CACHE_SECONDS = 10800;
const YESTERDAY_CACHE_SECONDS = 21600;
const HISTORY_CACHE_SECONDS = 86400;
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
   // GOLSKY TV - MULTICLUBES
if (url.pathname === "/api/videos") {

  if (!env.YOUTUBE_API_KEY) {
    return Response.json({
      erro: "YouTube API nao configurada"
    }, { status: 503 });
  }

  const cache = caches.default;

  const videoKey = new Request(
    url.origin + "/api/cache-youtube-v3"
  );

  try {

    const cached = await cache.match(videoKey);

    if (cached) {
      return cached;
    }

    const canais = [
      "@fcbarcelona",
      "@realmadrid",
      "@flamengo",
      "@palmeiras",
      "@corinthians",
      "@saopaulofc",
      "@santosfc",
      "@LiverpoolFC",
      "@mancity",
      "@ManchesterUnited",
      "@Arsenal",
      "@ChelseaFC",
      "@PSG",
      "@FCBayern",
      "@juventus",
      "@LaLiga",
      "@premierleague",
      "@Bundesliga",
      "@seriea",
      "@CONMEBOL"
    ];

    const chave = env.YOUTUBE_API_KEY.trim();

    async function consultar(endpoint, parametros) {

      const endereco = new URL(
        "https://www.googleapis.com/youtube/v3/" +
        endpoint
      );

      for (const [nome, valor] of Object.entries(parametros)) {
        endereco.searchParams.set(nome, valor);
      }

      endereco.searchParams.set("key", chave);

      const resposta = await fetch(endereco.toString());
      const dados = await resposta.json();

      if (!resposta.ok || dados.error) {
        throw new Error("Falha na API do YouTube");
      }

      return dados;
    }

    const listas = await Promise.allSettled(
      canais.map(async canal => {

        const dadosCanal = await consultar("channels", {
          part: "contentDetails",
          forHandle: canal
        });

        const playlist = dadosCanal.items?.[0]
          ?.contentDetails?.relatedPlaylists?.uploads;

        if (!playlist) {
          return [];
        }

        const dados = await consultar("playlistItems", {
          part: "snippet,contentDetails",
          playlistId: playlist,
          maxResults: "10"
        });

        return dados.items || [];

      })
    );

    const itens = listas
      .filter(lista => lista.status === "fulfilled")
      .flatMap(lista => lista.value);

    const candidatos = itens.filter(item => {

      const titulo = item.snippet?.title || "";

      const positivos =
        /highlights|goals?|gols?|goles|resumen|melhores momentos|resumo|resum|golazo|tore|buts|reti/i;

      const negativos =
        /preview|training|treino|entrevista|interview|react|reaction|simula|gameplay|efootball|fifa gameplay/i;

      return positivos.test(titulo) &&
        !negativos.test(titulo) &&
        item.contentDetails?.videoId;

    });

    const ids = [...new Set(
      candidatos.map(item => item.contentDetails.videoId)
    )];

    const videos = [];

    for (let i = 0; i < ids.length; i += 50) {

      const grupo = ids.slice(i, i + 50);

      const dados = await consultar("videos", {
        part: "snippet,status,contentDetails",
        id: grupo.join(",")
      });

      for (const item of dados.items || []) {

        if (!item.status?.embeddable) continue;
        if (item.status?.privacyStatus !== "public") continue;

        const regiao = item.contentDetails?.regionRestriction;

        if (regiao?.blocked?.includes("BR")) continue;

        if (regiao?.allowed &&
            !regiao.allowed.includes("BR")) continue;

        const postagem = new Date(item.snippet.publishedAt);

        const idade = Date.now() - postagem.getTime();

        if (idade > 7 * 86400000) continue;

        videos.push({

          id: item.id,
          titulo: item.snippet.title,
          canal: item.snippet.channelTitle,
          canalId: item.snippet.channelId,
          publicadoEm: item.snippet.publishedAt,

          imagem:
            item.snippet.thumbnails?.high?.url ||
            item.snippet.thumbnails?.medium?.url ||
            "",

          player:
            "https://www.youtube.com/embed/" + item.id

        });

      }

    }

    videos.sort((a, b) =>
      new Date(b.publicadoEm) -
      new Date(a.publicadoEm)
    );

    const selecionados = videos.slice(0, 100);

    if (listas.every(lista => lista.status === "rejected")) {
      throw new Error("Canais indisponiveis");
    }

    const resultado = Response.json({

      sistema: "GOLSKY TV MULTICLUBES",
      fonte: "YouTube",
      atualizadoEm: new Date().toISOString(),
      canaisConsultados: canais.length,
      total: selecionados.length,
      videos: selecionados

    }, {

      headers: {
        "Cache-Control": "public, max-age=1800"
      }

    });

    await cache.put(
      videoKey,
      resultado.clone()
    ).catch(() => {});

    return resultado;

  } catch {

    return Response.json({

      erro: "Videos temporariamente indisponiveis"

    }, { status: 503 });

  }

}    // STATUS DO SISTEMA
    if (url.pathname === "/api/status") {
      return Response.json({
        sistema: "GOLSKY",
        status: "online",
        apiConfigurada: Boolean(env.API_FOOTBALL_KEY),
        cacheSegundos: CACHE_SECONDS,
        cacheEventos: EVENTS_CACHE_SECONDS,
        cacheFuturo: FUTURE_CACHE_SECONDS,
        cacheOntem: YESTERDAY_CACHE_SECONDS,
        cacheHistorico: HISTORY_CACHE_SECONDS,
        timezone: TIMEZONE,
        modo: "calendario-mundial",
        calendario: true,
        eventos: true,
        versao: "6.2"
      });
    }

    // CONSULTA DE LANCES E EVENTOS
    if (url.pathname === "/api/eventos") {

      if (!env.API_FOOTBALL_KEY) {
        return Response.json({
          erro: "API nao configurada"
        }, { status: 503 });
      }

      const id = url.searchParams.get("id");

      if (!id || !/^[1-9]\d{0,11}$/.test(id)) {
        return Response.json({
          erro: "ID da partida invalido"
        }, { status: 400 });
      }

      const cache = caches.default;

      const eventKey = new Request(
        url.origin + "/api/cache-eventos/" + id
      );

      const eventBackupKey = new Request(
        url.origin + "/api/backup-eventos/" + id
      );

      const eventRetryKey = new Request(
        url.origin + "/api/retry-eventos/" + id
      );

      async function backupEventos() {
        const backup = await cache.match(eventBackupKey);

        if (backup) {
          const dados = await backup.json();

          return Response.json({
            ...dados,
            golsky: {
              ...dados.golsky,
              desatualizado: true
            }
          }, {
            headers: {
              "Cache-Control": "no-store"
            }
          });
        }

        return Response.json({
          erro: "Eventos temporariamente indisponiveis",
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

        const cached = await cache.match(eventKey);

        if (cached) {
          return cached;
        }

        if (await cache.match(eventRetryKey)) {
          return await backupEventos();
        }

        const apiUrl = new URL(
          "https://v3.football.api-sports.io/fixtures/events"
        );

        apiUrl.searchParams.set("fixture", id);

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

          console.error(
            "GOLSKY EVENTOS:",
            resposta.status,
            JSON.stringify(dados.errors || {})
          );

          const diagnostico = Response.json({
            erro: "Falha na API de eventos",
            statusAPI: resposta.status,
            detalhes: dados.errors,
            parametros: dados.parameters,
            resultados: dados.results
          }, {
            status: 502,
            headers: {
              "Cache-Control": "no-store"
            }
          });

          await cache.put(
            eventRetryKey,
            new Response("aguarde", {
              headers: {
                "Cache-Control":
                  "public, max-age=" + RETRY_SECONDS
              }
            })
          ).catch(() => {});

          return diagnostico;
        }

        dados.golsky = {
          partida: id,
          atualizadoEm: new Date().toISOString(),
          desatualizado: false
        };

        const resultado = Response.json(dados, {
          headers: {
            "Cache-Control":
              "public, max-age=" + EVENTS_CACHE_SECONDS,
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
          cache.put(eventKey, resultado.clone()),
          cache.put(eventBackupKey, backup)
        ]);

        return resultado;

      } catch (erro) {

        console.error("GOLSKY EVENTOS:", erro.message);

        try {
          await cache.put(
            eventRetryKey,
            new Response("aguarde", {
              headers: {
                "Cache-Control":
                  "public, max-age=" + RETRY_SECONDS
              }
            })
          );
        } catch {}

        return await backupEventos();
      }
    }

    // CALENDARIO MUNDIAL DE JOGOS
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

      // DATA ESCOLHIDA PELO USUARIO
      const dataSolicitada =
        url.searchParams.get("data") ??
        url.searchParams.get("date") ??
        hoje;

      // VALIDACAO DA DATA
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataSolicitada)) {
        return Response.json({
          erro: "Data invalida. Use AAAA-MM-DD"
        }, { status: 400 });
      }

      const dataObjeto = new Date(
        dataSolicitada + "T00:00:00Z"
      );

      if (
        !Number.isFinite(dataObjeto.getTime()) ||
        dataObjeto.toISOString().slice(0, 10) !== dataSolicitada
      ) {
        return Response.json({
          erro: "Data inexistente"
        }, { status: 400 });
      }

      const hojeObjeto = new Date(
        hoje + "T00:00:00Z"
      );

      const diferencaDias = Math.round(
        (dataObjeto - hojeObjeto) / 86400000
      );

      // LIMITE PARA PROTEGER A API GRATUITA
      if (diferencaDias < -365 || diferencaDias > 90) {
        return Response.json({
          erro: "Data fora do periodo permitido",
          limitePassado: 365,
          limiteFuturo: 90
        }, { status: 400 });
      }

      // CACHE INTELIGENTE POR DATA
      let tempoCache = CACHE_SECONDS;
      let periodo = "hoje";

      if (diferencaDias === -1) {
        tempoCache = YESTERDAY_CACHE_SECONDS;
        periodo = "ontem";
      } else if (diferencaDias < -1) {
        tempoCache = HISTORY_CACHE_SECONDS;
        periodo = "historico";
      } else if (diferencaDias > 0) {
        tempoCache = FUTURE_CACHE_SECONDS;
        periodo = "futuro";
      }

      const cache = caches.default;

      const cacheKey = new Request(
        url.origin + "/api/cache-jogos-v62/" +
        dataSolicitada + "/" + periodo
      );

      const backupKey = new Request(
        url.origin + "/api/cache-backup/" +
        dataSolicitada
      );

      const retryKey = new Request(
        url.origin + "/api/cache-retry/" +
        dataSolicitada
      );

      async function usarBackup() {

        const backup = await cache.match(backupKey);

        if (backup) {
          const dados = await backup.json();

          return Response.json({
            ...dados,
            golsky: {
              ...dados.golsky,
              data: dataSolicitada,
              periodo: periodo,
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
          data: dataSolicitada,
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

        apiUrl.searchParams.set(
          "date",
          dataSolicitada
        );

        apiUrl.searchParams.set(
          "timezone",
          TIMEZONE
        );

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

          console.error(
            "GOLSKY API:",
            resposta.status,
            JSON.stringify(dados.errors || {})
          );

          throw new Error("Falha na API");
        }

        dados.golsky = {
          atualizadoEm: new Date().toISOString(),
          desatualizado: false,
          data: dataSolicitada,
          periodo: periodo,
          cacheSegundos: tempoCache,
          timezone: TIMEZONE
        };

        const resultado = Response.json(dados, {
          headers: {
            "Cache-Control":
              "public, max-age=" + tempoCache,
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
