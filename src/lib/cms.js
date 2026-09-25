const sql = require("../db");
const { z } = require("./validation");
const { mediaByIds, mediaJson } = require("./media");
const DEFAULT_CONTENT = require("../seed/content.json");

// ─── Schemas do conteúdo editável (tudo que aparece no site) ───
const str = (max) => z.string().trim().max(max);
const lines = (n, max = 60) => z.array(str(max)).min(1).max(n);
const FORM_OPCOES = ["site_landing", "trafego_pago", "estrategia", "nao_sei"];

const CONTENT_SCHEMAS = {
    seo: z.object({ titulo: str(120), descricao: str(300) }),
    contatos: z.object({
        whatsapp: z.string().trim().max(20).transform((v) => v.replace(/\D/g, "")),
        email: z.union([z.literal(""), z.string().trim().email().max(160)]),
        instagram: z.union([z.literal(""), z.string().trim().url().max(300)]),
        cidade: str(80),
        regiao: str(40),
        mensagem_whatsapp: str(400),
    }),
    hero: z.object({
        kicker_esquerda: str(80),
        kicker_direita: str(80),
        titulo: lines(4, 24),
        subtitulo: str(200),
        cta: str(60),
        scroll: str(40),
    }),
    sobre: z.object({
        label: str(40),
        titulo: lines(4),
        texto: str(400),
        destaques: z.array(str(40)).max(12),
        pilares: z.array(str(40)).max(6),
    }),
    servicos: z.object({
        label: str(40),
        titulo: lines(4),
        itens: z
            .array(
                z.object({
                    titulo: str(80),
                    descricao: str(240),
                    pontos: z.array(str(80)).max(6),
                    visual: z.enum(["rings", "vector", "grid", "dot", "wave"]),
                    opcao_formulario: z.enum(FORM_OPCOES).nullable().optional(),
                })
            )
            .min(1)
            .max(8),
    }),
    cases_secao: z.object({ label: str(40), titulo: lines(4) }),
    break: z.object({ linha1: str(80), linha2: str(80) }),
    contato: z.object({
        label: str(40),
        titulo: lines(4, 24),
        texto: str(200),
        cta: str(60),
        form_titulo: str(60),
        form_texto: str(240),
        sucesso_titulo: str(60),
        sucesso_texto: str(200),
    }),
    rodape: z.object({ claim: str(200) }),
    case_pagina: z.object({ cta_titulo: str(80), cta: str(60) }),
};
const CONTENT_KEYS = Object.keys(CONTENT_SCHEMAS);

async function loadContent() {
    const rows = await sql`SELECT chave, valor, atualizado_em FROM site_content`;
    const out = {};
    for (const k of CONTENT_KEYS) out[k] = { ...DEFAULT_CONTENT[k] };
    let latest = 0;
    for (const r of rows) {
        if (!CONTENT_KEYS.includes(r.chave)) continue;
        out[r.chave] = { ...out[r.chave], ...r.valor };
        latest = Math.max(latest, new Date(r.atualizado_em).getTime());
    }
    return { content: out, latest };
}

// ─── Cases ───
const LAYOUTS = ["feature", "tall", "square", "wide", "panorama"];
const ART_KINDS = ["rings", "vector", "grid", "dot", "wave"];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidOrNull = z.union([z.string().uuid(), z.null()]).optional();
const optText = (max) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const caseSchema = z.object({
    slug: z.string().trim().toLowerCase().min(2).max(120).regex(SLUG_RE, "Use letras minúsculas, números e hífens."),
    cliente: z.string().trim().min(1).max(160),
    tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
    ano: optText(10),
    resumo: optText(400),
    desafio: optText(4000),
    solucao: optText(4000),
    resultado: optText(4000),
    entregas: z.array(z.string().trim().min(1).max(120)).max(16).default([]),
    destaque_valor: optText(40),
    destaque_label: optText(160),
    url: z.union([z.literal(""), z.string().trim().url().max(500)]).nullish().transform((v) => v || null),
    layout: z.enum(LAYOUTS).default("feature"),
    arte: z
        .object({
            kind: z.enum(ART_KINDS),
            origin: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
            tone: z.enum(["blue", "white"]),
        })
        .default({ kind: "rings", origin: [0.6, 0.55], tone: "blue" }),
    capa_id: uuidOrNull,
    capa_alt: optText(300),
    galeria: z
        .array(
            z.object({
                media_id: z.string().uuid(),
                alt: z.string().trim().max(300).default(""),
                legenda: z.string().trim().max(300).default(""),
                largura: z.enum(["full", "half"]).default("full"),
            })
        )
        .max(40)
        .default([]),
    seo_titulo: optText(160),
    seo_descricao: optText(300),
    publicado: z.boolean().default(false),
});

// Serializa cases resolvendo as mídias (capa + galeria) de uma vez
async function serializeCases(rows, { full = true } = {}) {
    const ids = rows.flatMap((c) => [c.capa_id, ...(full ? (c.galeria || []).map((g) => g.media_id) : [])]);
    const media = await mediaByIds(ids);
    return rows.map((c) => {
        const base = {
            id: c.id,
            slug: c.slug,
            cliente: c.cliente,
            tags: c.tags,
            ano: c.ano,
            resumo: c.resumo,
            entregas: c.entregas,
            destaque: c.destaque_valor ? { valor: c.destaque_valor, label: c.destaque_label || "" } : null,
            url: c.url,
            layout: c.layout,
            arte: c.arte,
            capa: mediaJson(media.get(c.capa_id), c.capa_alt || c.cliente),
            publicado: c.publicado,
            ordem: c.ordem,
            atualizado_em: c.atualizado_em,
        };
        if (!full) return base;
        return {
            ...base,
            desafio: c.desafio,
            solucao: c.solucao,
            resultado: c.resultado,
            galeria: (c.galeria || [])
                .map((g) => {
                    const m = mediaJson(media.get(g.media_id), g.alt);
                    return m ? { ...m, legenda: g.legenda || "", largura: g.largura || "full" } : null;
                })
                .filter(Boolean),
            seo_titulo: c.seo_titulo,
            seo_descricao: c.seo_descricao,
        };
    });
}

module.exports = { CONTENT_SCHEMAS, CONTENT_KEYS, loadContent, caseSchema, serializeCases, LAYOUTS, ART_KINDS, DEFAULT_CONTENT };
