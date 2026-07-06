// ============================================
// FUNÇÃO NETLIFY - SITEMAP.XML DINÂMICO
// Servido em https://obeh.com.br/sitemap.xml (redirect no netlify.toml,
// declarado ANTES do rewrite genérico /:slug — senão "sitemap.xml" seria
// tratado como slug de loja).
//
// Lista as páginas fixas indexáveis + todos os produtos ativos e lojas,
// direto do Supabase. Lojas com slug usam o link bonito (obeh.com.br/slug).
//
// Precisa de SUPABASE_SERVICE_ROLE_KEY.
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SITE_URL = process.env.SITE_URL || 'https://obeh.com.br'

const PAGINAS_FIXAS = ['', 'lojas.html', 'cursos.html', 'embaixadores.html', 'termos.html']

async function supabaseRequest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res.json()
}

function escapeXml(texto) {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function urlTag(loc, lastmod) {
  const lastmodTag = lastmod ? `<lastmod>${String(lastmod).slice(0, 10)}</lastmod>` : ''
  return `<url><loc>${escapeXml(loc)}</loc>${lastmodTag}</url>`
}

exports.handler = async () => {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: 'Servidor não configurado.' }
  }

  try {
    const [produtos, lojas] = await Promise.all([
      supabaseRequest('produtos?status=eq.ativo&select=id,created_at&order=created_at.desc&limit=5000'),
      supabaseRequest('lojas?select=id,slug,created_at&limit=2000')
    ])

    const urls = [
      ...PAGINAS_FIXAS.map(p => urlTag(`${SITE_URL}/${p}`)),
      ...lojas.map(l => urlTag(
        l.slug ? `${SITE_URL}/${l.slug}` : `${SITE_URL}/loja.html?id=${l.id}`,
        l.created_at
      )),
      ...produtos.map(p => urlTag(`${SITE_URL}/produto.html?id=${p.id}`, p.created_at))
    ]

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        // Cache de 1h na CDN — sitemap não precisa ser em tempo real
        'Cache-Control': 'public, max-age=3600'
      },
      body: xml
    }
  } catch (err) {
    console.error('Erro ao gerar sitemap:', err)
    return { statusCode: 500, body: 'Erro ao gerar o sitemap.' }
  }
}
