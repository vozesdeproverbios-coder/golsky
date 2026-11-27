
// GOLSKY WORKER 7.0
// CONTROLE INTELIGENTE DE API

const TIMEZONE = "America/Sao_Paulo";
const CACHE_SECONDS = 1200;
const EVENTS_CACHE_SECONDS = 900;
const FUTURE_CACHE_SECONDS = 10800;
const YESTERDAY_CACHE_SECONDS = 21600;
const HISTORY_CACHE_SECONDS = 86400;
const BACKUP_SECONDS = 86400;

const DAILY_LIMIT = 90;
const SECONDARY_LIMIT = 20;
const MIN_INTERVAL = 15000;
const RETRY_SECONDS = 180;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function hojeBrasil() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const obter = tipo =>
    partes.find(p => p.type === tipo).value;

  return obter("year") + "-" +
    obter("month") + "-" +
    obter("day");
}

// CONTROLADOR CENTRAL

export class GolskyControl {

  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ocupado = false;

    this.sql = ctx.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS controle (
        id INTEGER PRIMARY KEY,
        dia TEXT NOT NULL,
        consultas INTEGER NOT NULL,
        secundarias INTEGER NOT NULL,
        ultima INTEGER NOT NULL,
        bloqueio INTEGER NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS resultados (
        chave TEXT PRIMARY KEY,
        dados TEXT NOT NULL,
        atualizado INTEGER NOT NULL,
        validade INTEGER NOT NULL
      )
    `);
  }

  estado() {
    const dia = new Date().toISOString().slice(0, 10);

    this.sql.exec(`
      INSERT OR IGNORE INTO controle
      VALUES (1, ?, 0, 0, 0, 0)
    `, dia);

    this.sql.exec(`
      UPDATE controle
      SET dia = ?, consultas = 0, secundarias = 0
      WHERE id = 1 AND dia != ?
    `, dia, dia);

    return this.sql.exec(`
      SELECT * FROM controle WHERE id = 1
    `).toArray()[0];
  }

  async fetch(request) {

    const url = new URL(request.url);
    const estado = this.estado();

    if (url.pathname === "/status") {
      return json({
        sistema: "GOLSKY CONTROL 7.0",
        status: "online",
        diaUTC: estado.dia,
        consultasRealizadas: estado.consultas,
        consultasSecundarias: estado.secundarias,
        limiteInterno: DAILY_LIMIT,
        limitePlano: 100,
        saldoInterno: Math.max(
          0, DAILY_LIMIT - estado.consultas
        ),
        intervaloMinimoSegundos: MIN_INTERVAL / 1000,
        bloqueado: estado.bloqueio > Date.now(),
        bloqueadoAte: estado.bloqueio > Date.now()
          ? new Date(estado.bloqueio).toISOString()
          : null,
        consultaEmAndamento: this.ocupado
      });
    }

    if (url.pathname !== "/consultar" ||
        request.method !== "POST") {
      return json({ erro: "Rota invalida" }, 404);
    }

    const entrada = await request.json();

    const tipo = entrada.tipo;
    const valor = String(entrada.valor || "");

    if (
      !["jogos", "eventos"].includes(tipo) ||
      (tipo === "eventos" &&
        !/^[1-9]\d{0,11}$/.test(valor)) ||
      (tipo === "jogos" &&
        !/^\d{4}-\d{2}-\d{2}$/.test(valor))
    ) {
      return json({ erro: "Consulta invalida" }, 400);
    }

    const chave = tipo + ":" + valor;
    const agora = Date.now();

    const registro = this.sql.exec(`
      SELECT * FROM resultados WHERE chave = ?
    `, chave).toArray()[0];

    function entregar(registro, desatualizado, motivo) {
      const dados = JSON.parse(registro.dados);

      dados.golsky = {
        ...dados.golsky,
        desatualizado,
        aviso: motivo || null
      };

      return json(dados);
    }

    function backup(motivo) {
      if (registro &&
          agora - registro.atualizado <=
          BACKUP_SECONDS * 1000) {
        return entregar(registro, true, motivo);
      }

      return json({
        erro: motivo,
        response: [],
        golsky: {
          desatualizado: true
        }
      }, 503);
    }

    if (registro && registro.validade > agora) {
      return entregar(registro, false, null);
    }

    const secundario =
      tipo === "eventos" || valor !== hojeBrasil();

    if (estado.consultas >= DAILY_LIMIT) {
      return backup("Limite interno diario atingido");
    }

    if (secundario &&
        estado.secundarias >= SECONDARY_LIMIT) {
      return backup("Limite de consultas secundarias");
    }

    if (estado.bloqueio > agora) {
      return backup("API em espera de seguranca");
    }

    if (this.ocupado) {
      return backup("Atualizacao em andamento");
    }

    if (agora - estado.ultima < MIN_INTERVAL) {
      return backup("Intervalo de seguranca");
    }

    if (!this.env.API_FOOTBALL_KEY) {
      return backup("API nao configurada");
    }

    this.ocupado = true;

    try {

      this.sql.exec(`
        UPDATE controle
        SET consultas = consultas + 1,
            secundarias = secundarias + ?,
            ultima = ?
        WHERE id = 1
      `, secundario ? 1 : 0, agora);

      const endereco = new URL(
        tipo === "eventos"
          ? "https://v3.football.api-sports.io/fixtures/events"
          : "https://v3.football.api-sports.io/fixtures"
      );

      if (tipo === "eventos") {
        endereco.searchParams.set("fixture", valor);
      } else {
        endereco.searchParams.set("date", valor);
        endereco.searchParams.set("timezone", TIMEZONE);
      }

      const resposta = await fetch(endereco.toString(), {
        headers: {
          "x-apisports-key":
            this.env.API_FOOTBALL_KEY.trim()
        },
        signal: AbortSignal.timeout(15000)
      });

      const dados = await resposta.json();

      const saldoHeader = resposta.headers.get(
        "x-ratelimit-requests-remaining"
      );

      const saldoAPI = saldoHeader !== null
        ? Number(saldoHeader)
        : null;

      if (saldoAPI !== null &&
          Number.isFinite(saldoAPI)) {

        const consumidas = Math.max(
          0, 100 - saldoAPI
        );

        this.sql.exec(`
          UPDATE controle
          SET consultas = MAX(consultas, ?)
          WHERE id = 1
        `, consumidas);
      }

      if (
        !resposta.ok ||
        Object.keys(dados.errors || {}).length > 0 ||
        !Array.isArray(dados.response)
      ) {
        console.error(
          "GOLSKY CONTROL:",
          resposta.status,
          JSON.stringify(dados.errors || {})
        );

        throw new Error("Falha ou limite da API");
      }

      let tempoCache = CACHE_SECONDS;
      let periodo = "hoje";

      if (tipo === "eventos") {

        tempoCache = EVENTS_CACHE_SECONDS;

      } else {

        const diferenca = Math.round(
          (
            Date.parse(valor + "T00:00:00Z") -
            Date.parse(hojeBrasil() + "T00:00:00Z")
          ) / 86400000
        );

        if (diferenca === -1) {
          tempoCache = YESTERDAY_CACHE_SECONDS;
          periodo = "ontem";
        } else if (diferenca < -1) {
          tempoCache = HISTORY_CACHE_SECONDS;
          periodo = "historico";
        } else if (diferenca > 0) {
          tempoCache = FUTURE_CACHE_SECONDS;
          periodo = "futuro";
        } else {

          const aoVivo = dados.response.some(jogo =>
            ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]
              .includes(jogo.fixture?.status?.short)
          );

          tempoCache = aoVivo ? 1200 : 3600;
        }
      }

      const atualizado = Date.now();

      dados.golsky = {
        atualizadoEm: new Date(atualizado).toISOString(),
        desatualizado: false,
        cacheSegundos: tempoCache,
        timezone: TIMEZONE,
        ...(tipo === "eventos"
          ? { partida: valor }
          : { data: valor, periodo })
      };

      this.sql.exec(`
        INSERT INTO resultados
        (chave, dados, atualizado, validade)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chave) DO UPDATE SET
          dados = excluded.dados,
          atualizado = excluded.atualizado,
          validade = excluded.validade
      `,
        chave,
        JSON.stringify(dados),
        atualizado,
        atualizado + tempoCache * 1000
      );

      this.sql.exec(`
        DELETE FROM resultados
        WHERE atualizado < ?
      `, atualizado - 7 * 86400000);

      return json(dados);

    } catch (erro) {

      console.error("GOLSKY:", erro.message);

      this.sql.exec(`
        UPDATE controle SET bloqueio = ?
        WHERE id = 1
      `, Date.now() + RETRY_SECONDS * 1000);

      return backup(
        "API temporariamente indisponivel"
      );

    } finally {
      this.ocupado = false;
    }
  }
}

// GOLSKY TV MULTICLUBES

async function carregarVideos(url, env) {

  if (!env.YOUTUBE_API_KEY) {
    return json({
      erro: "YouTube API nao configurada"
    }, 503);
  }

  const cache = caches.default;

  const videoKey = new Request(
    url.origin + "/api/cache-youtube-v3"
  );

  try {

    const cached = await cache.match(videoKey);
    if (cached) return cached;

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

    async function consultar(endpoint, parametros) {

      const endereco = new URL(
        "https://www.googleapis.com/youtube/v3/" +
        endpoint
      );

      for (const [nome, valor] of
        Object.entries(parametros)) {
        endereco.searchParams.set(nome, valor);
      }

      endereco.searchParams.set(
        "key", env.YOUTUBE_API_KEY.trim()
      );

      const resposta = await fetch(
        endereco.toString()
      );

      const dados = await resposta.json();

      if (!resposta.ok || dados.error) {
        throw new Error("Falha na API do YouTube");
      }

      return dados;
    }

    const listas = [];

    // Lotes pequenos para evitar excesso
    // de conexoes simultaneas.

    for (let i = 0; i < canais.length; i += 5) {

      const grupo = canais.slice(i, i + 5);

      const resultados = await Promise.allSettled(
        grupo.map(async canal => {

          const dadosCanal = await consultar(
            "channels", {
              part: "contentDetails",
              forHandle: canal
            }
          );

          const playlist = dadosCanal.items?.[0]
            ?.contentDetails?.relatedPlaylists?.uploads;

          if (!playlist) return [];

          const dados = await consultar(
            "playlistItems", {
              part: "snippet,contentDetails",
              playlistId: playlist,
              maxResults: "10"
            }
          );

          return dados.items || [];
        })
      );

      listas.push(...resultados);
    }

    if (listas.every(
      lista => lista.status === "rejected"
    )) {
      throw new Error("Canais indisponiveis");
    }

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
      candidatos.map(
        item => item.contentDetails.videoId
      )
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

        if (item.status?.privacyStatus !== "public")
          continue;

        const regiao =
          item.contentDetails?.regionRestriction;

        if (regiao?.blocked?.includes("BR"))
          continue;

        if (regiao?.allowed &&
            !regiao.allowed.includes("BR"))
          continue;

        const postagem =
          new Date(item.snippet.publishedAt);

        if (Date.now() - postagem.getTime() >
            7 * 86400000)
          continue;

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
            "https://www.youtube.com/embed/" +
            item.id
        });
      }
    }

    videos.sort((a, b) =>
      new Date(b.publicadoEm) -
      new Date(a.publicadoEm)
    );

    const selecionados = videos.slice(0, 100);

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
      videoKey, resultado.clone()
    ).catch(() => {});

    return resultado;

  } catch (erro) {

    console.error("GOLSKY TV:", erro.message);

    return json({
      erro: "Videos temporariamente indisponiveis"
    }, 503);
  }
}

// SERVIDOR PRINCIPAL

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    // ESCUDOS

    if (/^\/escudos\/\d+\.png$/.test(url.pathname)) {

      const id = url.pathname.split("/").pop();

      try {

        const imagem = await fetch(
          "https://media.api-sports.io/football/teams/" +
          id
        );

        if (!imagem.ok) {
          return new Response(
            "Escudo indisponivel",
            { status: 404 }
          );
        }

        return new Response(imagem.body, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400"
          }
        });

      } catch {

        return new Response(
          "Falha ao carregar escudo",
          { status: 502 }
        );
      }
    }

    // VIDEOS

    if (url.pathname === "/api/videos") {
      return carregarVideos(url, env);
    }

    // STATUS

    if (url.pathname === "/api/status") {

      return json({
        sistema: "GOLSKY",
        status: "online",
        versao: "7.0",
        apiConfigurada: Boolean(env.API_FOOTBALL_KEY),
        controleCentral: Boolean(env.GOLSKY_CONTROL),
        cacheSegundos: CACHE_SECONDS,
        cacheEventos: EVENTS_CACHE_SECONDS,
        cacheFuturo: FUTURE_CACHE_SECONDS,
        cacheOntem: YESTERDAY_CACHE_SECONDS,
        cacheHistorico: HISTORY_CACHE_SECONDS,
        timezone: TIMEZONE,
        modo: "calendario-mundial",
        calendario: true,
        eventos: true,
        limiteInterno: DAILY_LIMIT
      });
    }

    // ROTAS DE FUTEBOL

    if ([
      "/api/jogos",
      "/api/eventos",
      "/api/controle"
    ].includes(url.pathname)) {

      if (!env.GOLSKY_CONTROL) {
        return json({
          erro: "Controlador ainda nao configurado"
        }, 503);
      }

      const id = env.GOLSKY_CONTROL.idFromName(
        "golsky-central-global"
      );

      const central = env.GOLSKY_CONTROL.get(id);

      if (url.pathname === "/api/controle") {
        return central.fetch(
          "https://golsky.internal/status"
        );
      }

      let tipo;
      let valor;

      if (url.pathname === "/api/eventos") {

        tipo = "eventos";
        valor = url.searchParams.get("id");

        if (!valor ||
            !/^[1-9]\d{0,11}$/.test(valor)) {
          return json({
            erro: "ID da partida invalido"
          }, 400);
        }

      } else {

        tipo = "jogos";

        valor =
          url.searchParams.get("data") ??
          url.searchParams.get("date") ??
          hojeBrasil();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
          return json({
            erro: "Data invalida. Use AAAA-MM-DD"
          }, 400);
        }

        const data = new Date(
          valor + "T00:00:00Z"
        );

        if (
          !Number.isFinite(data.getTime()) ||
          data.toISOString().slice(0, 10) !== valor
        ) {
          return json({
            erro: "Data inexistente"
          }, 400);
        }

        const diferenca = Math.round(
          (
            data.getTime() -
            Date.parse(
              hojeBrasil() + "T00:00:00Z"
            )
          ) / 86400000
        );

        if (diferenca < -365 || diferenca > 90) {
          return json({
            erro: "Data fora do periodo permitido",
            limitePassado: 365,
            limiteFuturo: 90
          }, 400);
        }
      }

      try {

        return await central.fetch(
          "https://golsky.internal/consultar",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              tipo,
              valor
            })
          }
        );

      } catch (erro) {

        console.error(
          "GOLSKY CENTRAL:", erro.message
        );

        return json({
          erro: "Central temporariamente indisponivel",
          response: []
        }, 503);
      }
    }

    // SITE PRINCIPAL

    return env.ASSETS.fetch(request);
  }
};
