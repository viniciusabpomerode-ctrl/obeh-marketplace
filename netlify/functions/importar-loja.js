// ============================================
// FUNÇÃO NETLIFY - IMPORTAR LOJA DE OUTRA PLATAFORMA
// Self-service: o próprio vendedor cola a URL da loja dele no
// artesanou.com.br e autoriza (ver termo em dashboard.html) a extração
// dos dados PÚBLICOS de produto pra popular a loja dele no Obeh.
//
// Não importa dados de cliente/avaliação — só produto (título, preço,
// descrição, categoria, imagens, prazo de produção). Peso/dimensões
// nunca existem publicamente em nenhuma origem, então todo produto
// importado entra com pendente_dados_frete=true.
//
// Precisa de SUPABASE_SERVICE_ROLE_KEY e das variáveis do R2 (as mesmas
// já usadas em r2-presign.js).
// ============================================
const artesanouAdapter = require('./lib/artesanou-adapter')
const { mapearProdutoImportado } = require('./lib/mapear-produto-importado')
const { importarImagemParaR2 } = require('./lib/r2-upload-servidor')

const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const ADAPTERS = {
  artesanou: artesanouAdapter
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    body: options.body,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res.json()
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function identificarPlataforma(url) {
  if (/artesanou\.com\.br/i.test(url)) return 'artesanou'
  return null
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido.' }
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Servidor não configurado.' }) }
  }

  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corpo da requisição inválido.' }) }
  }

  const { userId, urlLoja, aceiteTermos } = payload

  if (!userId || !urlLoja || aceiteTermos !== true) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId, urlLoja e o aceite dos termos são obrigatórios.' }) }
  }

  const plataforma = identificarPlataforma(urlLoja)
  if (!plataforma || !ADAPTERS[plataforma]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Essa plataforma de origem ainda não é suportada pra importação.' }) }
  }
  const adapter = ADAPTERS[plataforma]

  try {
    // 1. Busca a loja do vendedor no Obeh
    const lojas = await supabaseRequest(`lojas?user_id=eq.${userId}&select=id`)
    const loja = lojas[0]
    if (!loja) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Loja do vendedor não encontrada no Obeh.' }) }
    }

    // 2. Registra o consentimento (auditoria: quem, quando, de onde, qual IP)
    const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || '').split(',')[0].trim() || null
    await supabaseRequest('importacoes_lojas', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ user_id: userId, loja_id: loja.id, url_origem: urlLoja, plataforma, ip })
    })

    // 3. Extrai a lista de produtos da loja de origem (todas as páginas)
    const cartoes = await adapter.extrairProdutosDaLoja(urlLoja)
    if (cartoes.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ publicados: 0, pendenteUpgrade: 0, pendenteDadosFrete: 0, semImagem: 0, extracaoIncompleta: 0, mensagem: 'Nenhum produto encontrado nessa loja.' }) }
    }

    // 4. Busca as categorias do Obeh pra tentar casar com a categoria de origem
    const categoriasObeh = await supabaseRequest('categorias?select=id,nome')

    // 5. Pra cada produto, busca os detalhes completos (com pausa educada
    // entre requisições) e já mapeia pro formato do Obeh
    const produtosMapeados = []
    for (const cartao of cartoes) {
      await esperar(300 + Math.random() * 500)
      let detalhes
      try {
        detalhes = await adapter.extrairDetalhesProduto(cartao.url)
      } catch (err) {
        console.error('Falha ao extrair detalhes de', cartao.url, err.message)
        // Sem detalhes completos, usa só o que a listagem já tinha
        detalhes = {
          urlOrigem: cartao.url,
          titulo: cartao.titulo,
          descricao: null,
          precoAtual: artesanouAdapter.parsePrecoBRL(cartao.precoAtualTexto),
          precoAntigo: artesanouAdapter.parsePrecoBRL(cartao.precoAntigoTexto),
          categoriaTexto: cartao.categoriaTexto,
          imagens: cartao.imagemThumb ? [cartao.imagemThumb] : [],
          sobEncomenda: Boolean(cartao.prazoProducaoTexto),
          prazoProducaoDias: artesanouAdapter.extrairDiasProducao(cartao.prazoProducaoTexto)
        }
      }
      produtosMapeados.push(mapearProdutoImportado(detalhes, { categoriasObeh, plataforma, loja }))
    }

    // 6. Sobe as imagens de cada produto pro R2 (pula silenciosamente as que falharem)
    for (const produto of produtosMapeados) {
      const urlsFinais = []
      for (const urlOrigemImg of produto.imagensOrigem) {
        try {
          const urlFinal = await importarImagemParaR2(urlOrigemImg, 'produtos')
          urlsFinais.push(urlFinal)
        } catch (err) {
          console.error('Falha ao importar imagem, pulando:', urlOrigemImg, err.message)
        }
        await esperar(200 + Math.random() * 300)
      }
      produto.fotos = urlsFinais
      produto.sem_imagem = urlsFinais.length === 0
      delete produto.imagensOrigem
    }

    // 7. Aplica o limite do plano: publica os primeiros N (na ordem extraída),
    // marca o excedente como pendente_upgrade. Produtos com extração
    // incompleta nunca contam pro limite nem publicam automaticamente.
    const usuarios = await supabaseRequest(`users?id=eq.${userId}&select=plano`)
    const planoSlug = usuarios[0]?.plano || 'free'
    const planos = await supabaseRequest(`planos?slug=eq.${planoSlug}&select=limite_produtos`)
    const limite = planos[0]?.limite_produtos // null = ilimitado

    const { length: totalExistente } = await supabaseRequest(`produtos?loja_id=eq.${loja.id}&select=id`)
    let slotsRestantes = limite === null || limite === undefined ? Infinity : Math.max(0, limite - totalExistente)

    const paraInserir = produtosMapeados.map(produto => {
      const { categoria_precisa_revisao, ...campos } = produto
      if (campos.extracao_incompleta) {
        return { ...campos, loja_id: loja.id, user_id: userId, status: 'inativo', pendente_upgrade: false, mes_criacao: new Date().toISOString().split('T')[0] }
      }
      if (slotsRestantes > 0) {
        slotsRestantes--
        return { ...campos, loja_id: loja.id, user_id: userId, status: 'ativo', pendente_upgrade: false, mes_criacao: new Date().toISOString().split('T')[0] }
      }
      return { ...campos, loja_id: loja.id, user_id: userId, status: 'inativo', pendente_upgrade: true, mes_criacao: new Date().toISOString().split('T')[0] }
    })

    if (paraInserir.length > 0) {
      await supabaseRequest('produtos', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify(paraInserir)
      })
    }

    // 8. Resumo final — um mesmo produto pode contar em mais de um grupo
    const resumo = {
      publicados: paraInserir.filter(p => p.status === 'ativo').length,
      pendenteUpgrade: paraInserir.filter(p => p.pendente_upgrade).length,
      pendenteDadosFrete: paraInserir.filter(p => p.pendente_dados_frete).length,
      semImagem: paraInserir.filter(p => p.sem_imagem).length,
      extracaoIncompleta: paraInserir.filter(p => p.extracao_incompleta).length,
      totalExtraido: paraInserir.length
    }

    return { statusCode: 200, body: JSON.stringify(resumo) }
  } catch (err) {
    console.error('Erro em importar-loja:', err)
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado ao importar a loja: ' + err.message }) }
  }
}
