const express = require("express");
const sql = require("../db");
const { requireAuth } = require("../middlewares/auth");
const { z, parse, intId, isUuid } = require("../lib/validation");
const { CONTENT_SCHEMAS, CONTENT_KEYS, loadContent, caseSchema, serializeCases } = require("../lib/cms");
const { processUpload } = require("../lib/media");

const router = express.Router();
router.use(requireAuth);
// JSON para tudo, exceto o upload binário de mídia (montado antes do parser global)
const json = express.json({ limit: "256kb" });
router.use((req, res, next) => (req.method === "POST" && req.path === "/media" ? next() : json(req, res, next)));

const who = (req) => req.user.nome || req.user.username;

// ─── Conteúdo do site ───
router.get("/content", async (_req, res) => {
    const { content } = await loadContent();
    const rows = await sql`SELECT chave, atualizado_em, atualizado_por FROM site_content`;
    res.json({ conteudo: content, meta: Object.fromEntries(rows.map((r) => [r.chave, { atualizado_em: r.atualizado_em, atualizado_por: r.atualizado_por }])) });
});

router.put("/content/:chave", async (req, res) => {
    const chave = req.params.chave;
    if (!CONTENT_KEYS.includes(chave)) return res.status(404).json({ error: "Bloco de conteúdo desconhecido." });
    const b = parse(CONTENT_SCHEMAS[chave], req.body, res);
    if (!b) return;
    await sql`
      INSERT INTO site_content (chave, valor, atualizado_em, atualizado_por) VALUES (${chave}, ${sql.json(b)}, NOW(), ${who(req)})
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`;
    res.json(b);
});

// ─── Cases ───
router.get("/cases", async (_req, res) => {
    const rows = await sql`SELECT * FROM cases ORDER BY ordem, id`;
    res.json(await serializeCases(rows, { full: false }));
});

async function caseById(id) {
    const rows = await sql`SELECT * FROM cases WHERE id = ${id}`;
    if (!rows[0]) return null;
    const [c] = await serializeCases(rows);
    // Para o editor: ids crus da galeria/capa além das mídias resolvidas
    return { ...c, capa_id: rows[0].capa_id, capa_alt: rows[0].capa_alt, galeria_raw: rows[0].galeria };
}

router.get("/cases/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    const c = await caseById(id);
    if (!c) return res.status(404).json({ error: "Case não encontrado." });
    res.json(c);
});

// Prévia de rascunho pelo slug (página /cases/:slug?preview=1 com token do painel)
router.get("/cases/slug/:slug", async (req, res) => {
    const rows = await sql`SELECT id FROM cases WHERE LOWER(slug) = LOWER(${String(req.params.slug).slice(0, 120)})`;
    if (!rows[0]) return res.status(404).json({ error: "Case não encontrado." });
    res.json({ case: await caseById(rows[0].id), anterior: null, proximo: null });
});

function caseValues(b) {
    return {
        slug: b.slug,
        cliente: b.cliente,
        tags: b.tags,
        ano: b.ano,
        resumo: b.resumo,
        desafio: b.desafio,
        solucao: b.solucao,
        resultado: b.resultado,
        entregas: b.entregas,
        destaque_valor: b.destaque_valor,
        destaque_label: b.destaque_label,
        url: b.url,
        layout: b.layout,
        arte: sql.json(b.arte),
        capa_id: b.capa_id ?? null,
        capa_alt: b.capa_alt,
        galeria: sql.json(b.galeria),
        seo_titulo: b.seo_titulo,
        seo_descricao: b.seo_descricao,
        publicado: b.publicado,
    };
}

const conflict = (err, res) => {
    if (err.code === "23505") return res.status(409).json({ error: "Já existe um case com esse slug." }), true;
    if (err.code === "23503") return res.status(400).json({ error: "Imagem não encontrada — envie de novo." }), true;
    return false;
};

router.post("/cases", async (req, res) => {
    const b = parse(caseSchema, req.body, res);
    if (!b) return;
    try {
        const [{ max }] = await sql`SELECT COALESCE(MAX(ordem), -1)::int AS max FROM cases`;
        const v = { ...caseValues(b), ordem: max + 1 };
        const rows = await sql`INSERT INTO cases ${sql(v)} RETURNING id`;
        res.status(201).json(await caseById(rows[0].id));
    } catch (err) {
        if (conflict(err, res)) return;
        console.error("Erro ao criar case:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.put("/cases/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    const b = parse(caseSchema, req.body, res);
    if (!b) return;
    try {
        const rows = await sql`UPDATE cases SET ${sql({ ...caseValues(b), atualizado_em: sql`NOW()` })} WHERE id = ${id} RETURNING id`;
        if (rows.length === 0) return res.status(404).json({ error: "Case não encontrado." });
        res.json(await caseById(id));
    } catch (err) {
        if (conflict(err, res)) return;
        console.error("Erro ao salvar case:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// PATCH /cms/cases/:id/publicado { publicado }
router.patch("/cases/:id/publicado", async (req, res) => {
    const id = intId(req.params.id);
    const b = parse(z.object({ publicado: z.boolean() }), req.body, res);
    if (!b) return;
    const rows = await sql`UPDATE cases SET publicado = ${b.publicado}, atualizado_em = NOW() WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) return res.status(404).json({ error: "Case não encontrado." });
    res.json({ ok: true });
});

// POST /cms/cases/ordem { ids: [3, 1, 2] }
router.post("/cases/ordem", async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.number().int().positive()).max(500) }), req.body, res);
    if (!b) return;
    await sql.begin(async (tx) => {
        for (const [i, id] of b.ids.entries()) await tx`UPDATE cases SET ordem = ${i}, atualizado_em = NOW() WHERE id = ${id}`;
    });
    res.json({ ok: true });
});

router.delete("/cases/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    await sql`DELETE FROM cases WHERE id = ${id}`;
    res.json({ ok: true });
});

// ─── Mídia ───
// POST /cms/media — corpo binário da imagem (Content-Type image/*), nome em X-Filename
router.post("/media", express.raw({ type: "image/*", limit: "20mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Envie o arquivo da imagem." });
    try {
        const nome = decodeURIComponent(String(req.get("x-filename") || "imagem")).slice(0, 255);
        const alt = req.get("x-alt") ? decodeURIComponent(String(req.get("x-alt"))).slice(0, 300) : null;
        const m = await processUpload(req.body, { nome, mime: req.get("content-type").split(";")[0], alt, autor: who(req) });
        res.status(201).json(m);
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error("Erro no upload:", err);
        res.status(400).json({ error: "Não foi possível processar a imagem." });
    }
});

router.get("/media", async (_req, res) => {
    const rows = await sql`
      SELECT id, nome, width, height, larguras, alt, tamanho_total, criado_por, criado_em FROM media ORDER BY criado_em DESC LIMIT 300`;
    res.json(rows);
});

router.patch("/media/:id", async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const b = parse(z.object({ alt: z.string().trim().max(300) }), req.body, res);
    if (!b) return;
    await sql`UPDATE media SET alt = ${b.alt} WHERE id = ${req.params.id}`;
    res.json({ ok: true });
});

router.delete("/media/:id", async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    await sql`DELETE FROM media WHERE id = ${req.params.id}`;
    res.json({ ok: true });
});

// ─── Publicação (rebuild do site para SEO) ───
// As alterações já aparecem no site na hora (o front busca o conteúdo ao abrir);
// o rebuild atualiza o HTML pré-renderizado que os buscadores leem.
router.get("/status", async (_req, res) => {
    const [{ ultima }] = await sql`
      SELECT GREATEST((SELECT MAX(atualizado_em) FROM site_content), (SELECT MAX(atualizado_em) FROM cases)) AS ultima`;
    const pub = await sql`SELECT valor FROM app_settings WHERE chave = 'ultima_publicacao'`;
    res.json({
        ultima_alteracao: ultima,
        ultima_publicacao: pub[0]?.valor || null,
        deploy_configurado: Boolean(process.env.SITE_DEPLOY_HOOK_URL),
    });
});

router.post("/publicar", async (req, res) => {
    const url = process.env.SITE_DEPLOY_HOOK_URL;
    if (!url) return res.status(400).json({ error: "Configure SITE_DEPLOY_HOOK_URL na API para publicar pelo painel." });
    try {
        const headers = process.env.SITE_DEPLOY_HOOK_TOKEN ? { Authorization: `Bearer ${process.env.SITE_DEPLOY_HOOK_TOKEN}` } : {};
        const r = await fetch(url, { method: process.env.SITE_DEPLOY_HOOK_METHOD || "GET", headers, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const valor = { em: new Date().toISOString(), por: who(req) };
        await sql`
          INSERT INTO app_settings (chave, valor, atualizado_em) VALUES ('ultima_publicacao', ${sql.json(valor)}, NOW())
          ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`;
        res.json({ ok: true, ...valor });
    } catch (err) {
        console.error("Erro ao disparar deploy:", err.message);
        res.status(502).json({ error: `O deploy não respondeu (${err.message}).` });
    }
});

module.exports = router;
