// ============================================
// FUNÇÃO NETLIFY EM SEGUNDO PLANO - IMPORTAR LOJA DE OUTRA PLATAFORMA
// Faz o trabalho pesado da importação (buscar todos os produtos, extrair
// detalhes de cada um, subir imagens pro R2). Funções "-background" do
// Netlify aguentam até 15 minutos, mas não devolvem resposta pra quem
// chamou — por isso todo o resultado é salvo direto na linha de
// "importacoes_lojas" (ver importar-loja-iniciar.js), e o dashboard
// acompanha consultando essa linha no Supabase até o status mudar de
// "processando" pra "concluida" ou "erro".
//
// Não importa dados de cliente/avaliação — só produto (título, preço,
// descrição, categoria, imagens, prazo de produção). Peso/dimensões
// nunca existem publicamente em nenhuma origem, então todo produto
// importado entra com pendente_dados_frete=true.
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

async function marcarImportacao(importacaoId, campos) {
  if (!importacaoId) return
  await supabaseRequest(`importacoes_lojas?id=eq.${importacaoId}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify({ ...campos, atualizado_em: new Date().toISOString() })
  }).catch(err => console.error('Falha ao atualizar status da importação:', err.message))
}

exports.handler = async (event) => {
  let payload
  try {
    payload = JSON.parse(event.body || '{}')
  } catch (err) {
    console.error('importar-loja-background: corpo inválido.')
    return { statusCode: 400, body: 'ok' }
  }

  const { userId, urlLoja, plataforma, lojaId, importacaoId } = payload
  const adapter = ADAPTERS[plataforma]

  if (!userId || !urlLoja || !lojaId || !adapter) {
    await marcarImportacao(importacaoId, { status: 'erro', erro_mensagem: 'Dados insuficientes pra processar a importação.' })
    return { statusCode: 200, body: 'ok' }
  }

  try {
    // 0. Nome de exibição da loja de origem, só pra mostrar no resumo pro
    // vendedor (não falha a importação se não conseguir pegar isso)
    let nomeLojaOrigem = null
    try {
      if (adapter.extrairNomeLoja) nomeLojaOrigem = await adapter.extrairNomeLoja(urlLoja)
    } catch (err) {
      console.error('Não foi possível extrair o nome da loja de origem:', err.message)
    }

    // 1. Extrai a lista de produtos da loja de origem (todas as páginas)
    const cartoes = await adapter.extrairProdutosDaLoja(urlLoja)
    if (cartoes.length === 0) {
      await marcarImportacao(importacaoId, {
        status: 'concluida',
        resumo: { publicados: 0, pendenteUpgrade: 0, pendenteDadosFrete: 0, semImagem: 0, extracaoIncompleta: 0, totalExtraido: 0, nomeLojaOrigem, mensagem: 'Nenhum produto encontrado nessa loja.' }
      })
      return { statusCode: 200, body: 'ok' }
    }

    // 2. Busca as categorias do Obeh pra tentar casar com a categoria de origem
    const categoriasObeh = await supabaseRequest('categorias?select=id,nome')

    // 3. Pra cada produto, busca os detalhes completos (com pausa educada
    // entre requisições) e já mapeia pro formato do Obeh
    const produtosMapeados = []
    for (const cartao of cartoes) {
      await esperar(300 + Math.random() * 500)
      let detalhes
      try {
        detalhes = await adapter.extrairDetalhesProduto(cartao.url)
      } catch (err) {
        console.error('Falha ao extrair detalhes de', cartao.url, err.message)
        detalhes = {
          urlOrigem: cartao.url,
          titulo: cartao.titulo,
          descricao: null,
          precoAtual: artesanouAdapter.parsePrecoBRL(cartao.precoAtualTexto),
          precoAntigo: artesanouAdapter.parsePrecoBRL(cartao.precoAntigoTexto),
          categoriaTexto: cartao.categoriaTexto,
          pastaOrigemTexto: null,
          imagens: cartao.imagemThumb ? [cartao.imagemThumb] : [],
          sobEncomenda: Boolean(cartao.prazoProducaoTexto),
          prazoProducaoDias: artesanouAdapter.extrairDiasProducao(cartao.prazoProducaoTexto)
        }
      }
      produtosMapeados.push(mapearProdutoImportado(detalhes, { categoriasObeh, plataforma, lojaId }))
    }

    // 4. Sobe as imagens de cada produto pro R2 (pula silenciosamente as que falharem)
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

    // 4.5 Cria pastas (folders) que não existem ainda nessa loja
    const nomesPastas = [...new Set(produtosMapeados.map(p => p.pasta_nome).filter(Boolean))]
    const pastaMap = {} // nome → id

    if (nomesPastas.length > 0) {
      // Busca pastas já existentes nessa loja
      const pastasExistentes = await supabaseRequest(`pastas?loja_id=eq.${lojaId}&select=id,nome`)
      for (const p of pastasExistentes) {
        pastaMap[p.nome] = p.id
      }

      // Cria as que faltam
      for (const nome of nomesPastas) {
        if (pastaMap[nome]) continue
        const nova = await supabaseRequest('pastas', {
          method: 'POST',
          prefer: 'return=representation',
          body: JSON.stringify({ loja_id: lojaId, nome, capa_url: null })
        })
        if (nova?.[0]) pastaMap[nome] = nova[0].id
      }

      // Atribui pasta_id nos produtos
      for (const produto of produtosMapeados) {
        if (produto.pasta_nome && pastaMap[produto.pasta_nome]) {
          produto.pasta_id = pastaMap[produto.pasta_nome]
        }
        delete produto.pasta_nome
      }
    } else {
      // Remove campo se não tem pasta
      for (const produto of produtosMapeados) {
        delete produto.pasta_nome
      }
    }

    // 5. Aplica o limite do plano: publica os primeiros N (na ordem extraída),
    // marca o excedente como pendente_upgrade. Produtos com extração
    // incompleta nunca contam pro limite nem publicam automaticamente.
    // Admin (viniciusbirnecker@gmail.com) pula o limite — publica tudo.
    const usuarios = await supabaseRequest(`users?id=eq.${userId}&select=plano,email`)
    const isAdmin = usuarios[0]?.email === 'viniciusbirnecker@gmail.com'
    const planoSlug = isAdmin ? 'ultra' : (usuarios[0]?.plano || 'free')
    const planos = await supabaseRequest(`planos?slug=eq.${planoSlug}&select=limite_produtos`)
    const limite = planos[0]?.limite_produtos // null = ilimitado (Ultra é ilimitado)

    const totalExistente = await supabaseRequest(`produtos?loja_id=eq.${lojaId}&select=id`)
    let slotsRestantes = limite === null || limite === undefined ? Infinity : Math.max(0, limite - totalExistente.length)

    const paraInserir = produtosMapeados.map(produto => {
      const { categoria_precisa_revisao, ...campos } = produto
      const base = { ...campos, loja_id: lojaId, user_id: userId, mes_criacao: new Date().toISOString().split('T')[0] }
      if (campos.extracao_incompleta) {
        return { ...base, status: 'inativo', pendente_upgrade: false }
      }
      if (slotsRestantes > 0) {
        slotsRestantes--
        return { ...base, status: 'ativo', pendente_upgrade: false }
      }
      return { ...base, status: 'inativo', pendente_upgrade: true }
    })

    if (paraInserir.length > 0) {
      await supabaseRequest('produtos', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify(paraInserir)
      })
    }

    // 6. Resumo final — um mesmo produto pode contar em mais de um grupo
    const resumo = {
      nomeLojaOrigem,
      publicados: paraInserir.filter(p => p.status === 'ativo').length,
      pendenteUpgrade: paraInserir.filter(p => p.pendente_upgrade).length,
      pendenteDadosFrete: paraInserir.filter(p => p.pendente_dados_frete).length,
      semImagem: paraInserir.filter(p => p.sem_imagem).length,
      extracaoIncompleta: paraInserir.filter(p => p.extracao_incompleta).length,
      totalExtraido: paraInserir.length
    }

    await marcarImportacao(importacaoId, { status: 'concluida', resumo })
    return { statusCode: 200, body: 'ok' }
  } catch (err) {
    console.error('Erro em importar-loja-background:', err)
    await marcarImportacao(importacaoId, { status: 'erro', erro_mensagem: err.message })
    return { statusCode: 200, body: 'ok' }
  }
}
