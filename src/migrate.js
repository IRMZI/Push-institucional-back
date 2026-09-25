const { assertRequiredEnv } = require("./config");

// Migrations idempotentes: podem rodar quantas vezes for preciso (deploy a deploy).
// Toda alteração nova entra no fim, sempre com IF NOT EXISTS / ON CONFLICT.
async function migrate(sql) {
    await sql`
    CREATE TABLE IF NOT EXISTS visitor_sessions (
      id UUID PRIMARY KEY,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ultimo_acesso TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      visitas INT NOT NULL DEFAULT 0,
      landing_page TEXT,
      referrer TEXT,
      dispositivo VARCHAR(20),
      browser VARCHAR(60),
      os VARCHAR(60),
      idioma VARCHAR(20),
      resolucao VARCHAR(20),
      viewport VARCHAR(20),
      user_agent TEXT,
      ip_hash VARCHAR(64),
      -- last-touch (visita mais recente)
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      fbclid VARCHAR(500),
      gclid VARCHAR(500),
      -- first-touch (primeira visita, nunca sobrescrito)
      ft_utm_source VARCHAR(255),
      ft_utm_medium VARCHAR(255),
      ft_utm_campaign VARCHAR(255),
      ft_utm_content VARCHAR(255),
      ft_utm_term VARCHAR(255),
      ft_fbclid VARCHAR(500),
      ft_gclid VARCHAR(500),
      ft_referrer TEXT,
      ft_landing_page TEXT,
      ft_em TIMESTAMPTZ,
      -- consentimento LGPD (all = pixels liberados, essential = só first-party)
      consentimento VARCHAR(20),
      consentimento_em TIMESTAMPTZ,
      -- agregados de jornada
      scroll_max INT NOT NULL DEFAULT 0,
      tempo_total INT NOT NULL DEFAULT 0,
      paginas INT NOT NULL DEFAULT 0,
      ultima_secao VARCHAR(60),
      convertido BOOLEAN NOT NULL DEFAULT false,
      convertido_em TIMESTAMPTZ,
      lead_id INT
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_sessions_criado ON visitor_sessions(criado_em)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_sessions_ultimo ON visitor_sessions(ultimo_acesso)`;

    await sql`
    CREATE TABLE IF NOT EXISTS session_events (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES visitor_sessions(id) ON DELETE CASCADE,
      visit_id UUID,
      tipo VARCHAR(40) NOT NULL,
      nome VARCHAR(120),
      pagina VARCHAR(500),
      valor INT,
      dados JSONB,
      ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, ocorrido_em)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_events_tipo ON session_events(tipo, ocorrido_em)`;
    // Uma única visit_start por visita — o upsert de sessão depende disso para contar visitas.
    await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_visit_start
      ON session_events(visit_id) WHERE tipo = 'visit_start'`;

    await sql`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(120) NOT NULL,
      whatsapp VARCHAR(20) NOT NULL,
      email VARCHAR(255),
      empresa VARCHAR(160),
      servicos TEXT[] NOT NULL DEFAULT '{}',
      investimento VARCHAR(40),
      mensagem TEXT,
      consentimento BOOLEAN NOT NULL DEFAULT false,
      consentimento_em TIMESTAMPTZ,
      status VARCHAR(30) NOT NULL DEFAULT 'novo',
      status_alterado_em TIMESTAMPTZ,
      session_id UUID REFERENCES visitor_sessions(id) ON DELETE SET NULL,
      event_id VARCHAR(80),
      pagina_origem TEXT,
      referrer TEXT,
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      ft_utm_source VARCHAR(255),
      ft_utm_medium VARCHAR(255),
      ft_utm_campaign VARCHAR(255),
      ft_utm_content VARCHAR(255),
      ft_utm_term VARCHAR(255),
      fbclid VARCHAR(500),
      gclid VARCHAR(500),
      user_agent TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deletado_em TIMESTAMPTZ
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_leads_criado ON leads(criado_em)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_leads_session ON leads(session_id)`;

    // FK de sessão → lead só depois de leads existir
    await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitor_sessions_lead_id_fkey') THEN
        ALTER TABLE visitor_sessions
          ADD CONSTRAINT visitor_sessions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
      END IF;
    END $$`;

    await sql`
    CREATE TABLE IF NOT EXISTS conversoes (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(80) NOT NULL UNIQUE,
      tipo VARCHAR(30) NOT NULL,
      session_id UUID REFERENCES visitor_sessions(id) ON DELETE SET NULL,
      lead_id INT REFERENCES leads(id) ON DELETE SET NULL,
      rotulo VARCHAR(120),
      pagina TEXT,
      destino TEXT,
      fbp VARCHAR(255),
      fbc VARCHAR(500),
      user_agent TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- status do envio à Meta Conversions API
      capi_evento VARCHAR(30),
      capi_status VARCHAR(20) NOT NULL DEFAULT 'pendente',
      capi_resposta JSONB,
      capi_tentativas INT NOT NULL DEFAULT 0,
      capi_enviado_em TIMESTAMPTZ
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conversoes_criado ON conversoes(criado_em)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conversoes_session ON conversoes(session_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_conversoes_capi ON conversoes(capi_status)`;

    await sql`
    CREATE TABLE IF NOT EXISTS lead_notes (
      id SERIAL PRIMARY KEY,
      lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      autor VARCHAR(100),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id)`;

    await sql`
    CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(40) NOT NULL,
      cor VARCHAR(7) NOT NULL DEFAULT '#164BFF',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_nome_lower ON tags (LOWER(nome))`;

    await sql`
    CREATE TABLE IF NOT EXISTS session_tags (
      session_id UUID NOT NULL REFERENCES visitor_sessions(id) ON DELETE CASCADE,
      tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, tag_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag_id)`;

    await sql`
    CREATE TABLE IF NOT EXISTS lead_tags (
      lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (lead_id, tag_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_lead_tags_tag ON lead_tags(tag_id)`;

    await sql`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(120) NOT NULL,
      utm_campaign VARCHAR(255) NOT NULL,
      canal VARCHAR(40),
      investimento NUMERIC(12,2) NOT NULL DEFAULT 0,
      inicio DATE,
      fim DATE,
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_utm ON campaigns (LOWER(utm_campaign))`;

    await sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(60) NOT NULL,
      nome VARCHAR(120),
      senha_hash VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'admin',
      ativo BOOLEAN NOT NULL DEFAULT true,
      ultimo_login TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users (LOWER(username))`;

    // Configurações chave/valor do painel (ex.: mensagens prontas do WhatsApp)
    await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      chave VARCHAR(60) PRIMARY KEY,
      valor JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    // ─── CMS: mídia, cases e conteúdo do site ───
    // Imagens ficam no próprio Postgres (variantes AVIF/WebP geradas no upload):
    // sem volume extra no Coolify e o backup do banco já inclui tudo.
    await sql`
    CREATE TABLE IF NOT EXISTS media (
      id UUID PRIMARY KEY,
      nome VARCHAR(255),
      mime_original VARCHAR(60),
      width INT NOT NULL,
      height INT NOT NULL,
      larguras INT[] NOT NULL DEFAULT '{}',
      alt VARCHAR(300),
      tamanho_total INT NOT NULL DEFAULT 0,
      criado_por VARCHAR(100),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`
    CREATE TABLE IF NOT EXISTS media_variants (
      media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      largura INT NOT NULL,
      formato VARCHAR(10) NOT NULL,
      conteudo BYTEA NOT NULL,
      tamanho INT NOT NULL,
      PRIMARY KEY (media_id, largura, formato)
    )`;

    await sql`
    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(120) NOT NULL,
      cliente VARCHAR(160) NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      ano VARCHAR(10),
      resumo TEXT,
      desafio TEXT,
      solucao TEXT,
      resultado TEXT,
      entregas TEXT[] NOT NULL DEFAULT '{}',
      destaque_valor VARCHAR(40),
      destaque_label VARCHAR(160),
      url VARCHAR(500),
      layout VARCHAR(20) NOT NULL DEFAULT 'feature',
      arte JSONB NOT NULL DEFAULT '{"kind":"rings","origin":[0.6,0.55],"tone":"blue"}',
      capa_id UUID REFERENCES media(id) ON DELETE SET NULL,
      capa_alt VARCHAR(300),
      galeria JSONB NOT NULL DEFAULT '[]',
      seo_titulo VARCHAR(160),
      seo_descricao VARCHAR(300),
      publicado BOOLEAN NOT NULL DEFAULT false,
      ordem INT NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_slug ON cases (LOWER(slug))`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cases_ordem ON cases (publicado, ordem)`;

    await sql`
    CREATE TABLE IF NOT EXISTS site_content (
      chave VARCHAR(60) PRIMARY KEY,
      valor JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_por VARCHAR(100)
    )`;

    // Seed do CMS com o conteúdo atual do site (só insere o que ainda não existe)
    const content = require("./seed/content.json");
    for (const [chave, valor] of Object.entries(content)) {
        await sql`INSERT INTO site_content (chave, valor) VALUES (${chave}, ${sql.json(valor)}) ON CONFLICT (chave) DO NOTHING`;
    }
    const seedCases = require("./seed/cases.json");
    const [{ n: totalCases }] = await sql`SELECT COUNT(*)::int AS n FROM cases`;
    if (totalCases === 0) {
        for (const [i, c] of seedCases.entries()) {
            await sql`
              INSERT INTO cases (slug, cliente, tags, resumo, entregas, destaque_valor, destaque_label, layout, arte, publicado, ordem)
              VALUES (${c.slug}, ${c.cliente}, ${c.tags}, ${c.resumo}, ${c.entregas}, ${c.destaque_valor ?? null},
                      ${c.destaque_label ?? null}, ${c.layout}, ${sql.json(c.arte)}, true, ${i})
              ON CONFLICT DO NOTHING`;
        }
    }

    // Seeds idempotentes
    const tags = [
        ["Quente", "#FF5A4E"],
        ["Morno", "#F2B84B"],
        ["Frio", "#7A9CFF"],
        ["Cliente", "#3DD68C"],
        ["Follow-up", "#B48CFF"],
    ];
    for (const [nome, cor] of tags) {
        await sql`
          INSERT INTO tags (nome, cor)
          SELECT ${nome}, ${cor}
          WHERE NOT EXISTS (SELECT 1 FROM tags WHERE LOWER(nome) = LOWER(${nome}))`;
    }

    await sql`
    INSERT INTO app_settings (chave, valor) VALUES (
      'whatsapp_templates',
      ${sql.json([
          {
              id: "primeiro-contato",
              titulo: "Primeiro contato",
              texto: "Oi, {primeiro_nome}! Aqui é da PUSH. Recebemos seu contato pelo site sobre {servicos}. Podemos conversar rapidinho sobre o momento da {empresa}?",
          },
          {
              id: "agendar-diagnostico",
              titulo: "Agendar diagnóstico",
              texto: "Oi, {primeiro_nome}! Tudo certo? Queria agendar um diagnóstico de 30 minutos para entender seus objetivos. Qual o melhor dia e horário pra você?",
          },
          {
              id: "follow-up",
              titulo: "Follow-up da proposta",
              texto: "Oi, {primeiro_nome}! Passando para saber se ficou alguma dúvida sobre a proposta que enviamos. Fico à disposição.",
          },
      ])}
    ) ON CONFLICT (chave) DO NOTHING`;
}

module.exports = { migrate };

if (require.main === module) {
    assertRequiredEnv();
    const sql = require("./db");
    console.log("Rodando migrations...");
    migrate(sql)
        .then(async () => {
            console.log("Migrations concluídas.");
            await sql.end();
            process.exit(0);
        })
        .catch(async (err) => {
            console.error("Erro na migração:", err);
            await sql.end({ timeout: 1 });
            process.exit(1);
        });
}
