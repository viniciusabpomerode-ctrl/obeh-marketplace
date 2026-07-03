// ============================================
// CONEXÃO COM SUPABASE - OBEH MARKETPLACE
// ============================================

const supabaseUrl = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6dnF0cGVzdHpybWlwY3lxYnNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MTkwNjUsImV4cCI6MjA5ODQ5NTA2NX0.AeL_tWbCT77miGrmJGd1qFrU50PiV6dOx_DUaj-EvmM'

// Inicializa o cliente Supabase
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey)

// ============================================
// FUNÇÕES DE AUTENTICAÇÃO
// ============================================

// Marca o primeiro login do usuário (usado para a janela de promoção de 5h)
async function registrarPrimeiroLogin(userId) {
  if (!userId) return
  try {
    const { data, error } = await supabaseClient
      .from('users')
      .select('primeiro_login_em')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      console.error('Erro ao verificar primeiro login:', error)
      return
    }

    if (data && !data.primeiro_login_em) {
      await supabaseClient
        .from('users')
        .update({ primeiro_login_em: new Date().toISOString() })
        .eq('id', userId)
    }
  } catch (e) {
    console.error('Erro ao registrar primeiro login:', e)
  }
}

// Login com email/senha
async function login(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  })
  if (error) {
    alert('❌ Erro ao fazer login: ' + error.message)
    return false
  }
  if (data?.user?.id) {
    await registrarPrimeiroLogin(data.user.id)
  }
  window.location.href = 'dashboard.html'
  return true
}

// Login com Google
async function loginComGoogle() {
  const { data, error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/dashboard.html'
    }
  })
  if (error) {
    alert('❌ Erro ao fazer login com Google: ' + error.message)
    return false
  }
  return true
}

// Login com Facebook
async function loginComFacebook() {
  const { data, error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'facebook',
    options: {
      redirectTo: window.location.origin + '/dashboard.html'
    }
  })
  if (error) {
    alert('❌ Erro ao fazer login com Facebook: ' + error.message)
    return false
  }
  return true
}

// Cadastro com email/senha
async function cadastrarUsuario(email, password, nome, telefone) {
  // 1. Cria o usuário
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: {
        nome: nome,
        telefone: telefone
      }
    }
  })

  if (error) {
    alert('❌ Erro no cadastro: ' + error.message)
    return false
  }

  if (data.user) {
    // 2. Cria a loja automaticamente
    const { error: lojaError } = await supabaseClient
      .from('lojas')
      .insert({
        user_id: data.user.id,
        nome_loja: `Loja de ${nome}`,
        ativa: false
      })

    if (lojaError) {
      console.error('Erro ao criar loja:', lojaError)
    }

    alert('✅ Cadastro realizado com sucesso! Faça login para continuar.')
    window.location.href = 'login.html'
    return true
  }

  return false
}

// Logout
async function logout() {
  await supabaseClient.auth.signOut()
  window.location.href = 'index.html'
}

// Pegar usuário atual
async function getCurrentUser() {
  const { data, error } = await supabaseClient.auth.getUser()
  if (error || !data.user) return null
  return data.user
}

// Verificar se está logado (redireciona se não estiver)
async function verificarUsuarioLogado() {
  const user = await getCurrentUser()
  if (!user) {
    window.location.href = 'login.html'
    return null
  }
  return user
}

// ============================================
// FUNÇÕES DE PRODUTOS
// ============================================

async function getProducts() {
  const { data, error } = await supabaseClient
    .from('produtos')
    .select(`
      *,
      lojas (nome_loja, logo, banner, mercado_pago_link),
      categorias (nome)
    `)
    .eq('status', 'ativo')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar produtos:', error)
    return []
  }
  return data
}

async function getUserProducts(userId) {
  const { data, error } = await supabaseClient
    .from('produtos')
    .select('*, categorias(nome)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar produtos do usuário:', error)
    return []
  }
  return data
}

async function criarProduto(produto) {
  const { data, error } = await supabaseClient
    .from('produtos')
    .insert(produto)
    .select()

  if (error) {
    alert('❌ Erro ao criar produto: ' + error.message)
    return null
  }
  return data[0]
}

async function atualizarProduto(id, updates) {
  const { data, error } = await supabaseClient
    .from('produtos')
    .update(updates)
    .eq('id', id)
    .select()

  if (error) {
    alert('❌ Erro ao atualizar: ' + error.message)
    return null
  }
  return data[0]
}

async function deletarProduto(id) {
  if (!confirm('Tem certeza que deseja deletar este produto?')) return false

  const { error } = await supabaseClient
    .from('produtos')
    .delete()
    .eq('id', id)

  if (error) {
    alert('❌ Erro ao deletar: ' + error.message)
    return false
  }

  alert('✅ Produto deletado!')
  return true
}

// ============================================
// FUNÇÕES DE LOJA
// ============================================

async function getLoja(userId) {
  const { data, error } = await supabaseClient
    .from('lojas')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('Erro ao buscar loja:', error)
    return null
  }
  return data
}

async function atualizarLoja(userId, updates) {
  const { data, error } = await supabaseClient
    .from('lojas')
    .update(updates)
    .eq('user_id', userId)
    .select()

  if (error) {
    alert('❌ Erro ao atualizar loja: ' + error.message)
    return null
  }
  return data[0]
}

// ============================================
// GARANTE PERFIL E LOJA (fallback caso o trigger do banco falhe)
// ============================================

async function ensureUserAndLoja(user) {
  if (!user) return

  // Garante que existe um perfil na tabela "users"
  const { data: perfilExistente, error: perfilCheckError } = await supabaseClient
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (perfilCheckError) {
    console.error('Erro ao verificar perfil do usuário:', perfilCheckError)
  }

  if (!perfilExistente) {
    const { error: perfilError } = await supabaseClient
      .from('users')
      .insert({
        id: user.id,
        email: user.email,
        nome: user.user_metadata?.nome || user.email,
        telefone: user.user_metadata?.telefone || null,
        plano: 'free'
      })

    if (perfilError) {
      console.error('Erro ao criar perfil de usuário:', perfilError)
    }
  }

  // Garante que existe uma loja para o usuário
  await ensureLoja(user.id, {
    nome_loja: `Loja de ${user.user_metadata?.nome || user.email}`
  })
}

async function ensureLoja(userId, defaults = {}) {
  const lojaExistente = await getLoja(userId)
  if (lojaExistente) return lojaExistente

  const { data, error } = await supabaseClient
    .from('lojas')
    .insert({
      user_id: userId,
      nome_loja: defaults.nome_loja || 'Minha loja',
      ativa: false
    })
    .select()

  if (error) {
    console.error('Erro ao criar loja:', error)
    return null
  }
  return data[0]
}

// ============================================
// FUNÇÕES DE CURSOS (plano Ultra)
// ============================================

async function getCursos() {
  const { data, error } = await supabaseClient
    .from('cursos')
    .select(`
      *,
      lojas (nome_loja, mercado_pago_link)
    `)
    .eq('status', 'ativo')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar cursos:', error)
    return []
  }
  return data
}

async function getCursosDaLoja(lojaId) {
  const { data, error } = await supabaseClient
    .from('cursos')
    .select('*')
    .eq('loja_id', lojaId)
    .eq('status', 'ativo')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar cursos da loja:', error)
    return []
  }
  return data
}

async function getUserCursos(userId) {
  const { data, error } = await supabaseClient
    .from('cursos')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar cursos do usuário:', error)
    return []
  }
  return data
}

async function getCurso(id) {
  const { data, error } = await supabaseClient
    .from('cursos')
    .select(`
      *,
      lojas (nome_loja, mercado_pago_link, whatsapp, instagram)
    `)
    .eq('id', id)
    .single()

  if (error) {
    console.error('Erro ao buscar curso:', error)
    return null
  }
  return data
}

async function criarCurso(curso) {
  const { data, error } = await supabaseClient
    .from('cursos')
    .insert(curso)
    .select()

  if (error) {
    alert('❌ Erro ao criar curso: ' + error.message)
    return null
  }
  return data[0]
}

async function atualizarCurso(id, updates) {
  const { data, error } = await supabaseClient
    .from('cursos')
    .update(updates)
    .eq('id', id)
    .select()

  if (error) {
    alert('❌ Erro ao atualizar curso: ' + error.message)
    return null
  }
  return data[0]
}

async function deletarCurso(id) {
  const { error } = await supabaseClient
    .from('cursos')
    .delete()
    .eq('id', id)

  if (error) {
    alert('❌ Erro ao excluir curso: ' + error.message)
    return false
  }
  return true
}

async function getTopicosCurso(cursoId) {
  const { data, error } = await supabaseClient
    .from('curso_topicos')
    .select('*')
    .eq('curso_id', cursoId)
    .order('ordem', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Erro ao buscar tópicos do curso:', error)
    return []
  }
  return data
}

async function criarTopicoCurso(topico) {
  const { data, error } = await supabaseClient
    .from('curso_topicos')
    .insert(topico)
    .select()

  if (error) {
    alert('❌ Erro ao criar tópico: ' + error.message)
    return null
  }
  return data[0]
}

async function deletarTopicoCurso(id) {
  const { error } = await supabaseClient
    .from('curso_topicos')
    .delete()
    .eq('id', id)

  if (error) {
    alert('❌ Erro ao excluir tópico: ' + error.message)
    return false
  }
  return true
}

async function registrarCompraCurso(cursoId, userId, valor) {
  const { data, error } = await supabaseClient
    .from('compras_curso')
    .insert({ curso_id: cursoId, user_id: userId, valor, status: 'pendente' })
    .select()

  if (error) {
    console.error('Erro ao registrar compra do curso:', error)
    return null
  }
  return data[0]
}

async function getCompraCurso(cursoId, userId) {
  const { data, error } = await supabaseClient
    .from('compras_curso')
    .select('*')
    .eq('curso_id', cursoId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('Erro ao verificar compra do curso:', error)
    return null
  }
  return data
}

// ============================================
// FUNÇÕES DE CATEGORIAS
// ============================================

async function getCategorias() {
  const { data, error } = await supabaseClient
    .from('categorias')
    .select('*')
    .order('nome')

  if (error) {
    console.error('Erro ao buscar categorias:', error)
    return []
  }
  return data
}

// ============================================
// FUNÇÕES DO CARRINHO
// ============================================

let carrinho = []

function adicionarAoCarrinho(produto) {
  const existente = carrinho.find(item => item.id === produto.id)
  if (existente) {
    existente.quantidade += 1
  } else {
    carrinho.push({ ...produto, quantidade: 1 })
  }
  atualizarCarrinhoUI()
}

function removerDoCarrinho(produtoId) {
  carrinho = carrinho.filter(item => item.id !== produtoId)
  atualizarCarrinhoUI()
}

function atualizarQuantidade(produtoId, delta) {
  const item = carrinho.find(i => i.id === produtoId)
  if (!item) return
  item.quantidade += delta
  if (item.quantidade <= 0) {
    carrinho = carrinho.filter(i => i.id !== produtoId)
  }
  atualizarCarrinhoUI()
}

function getTotalCarrinho() {
  return carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0)
}

function getQuantidadeCarrinho() {
  return carrinho.reduce((total, item) => total + item.quantidade, 0)
}

function atualizarCarrinhoUI() {
  const countEl = document.getElementById('cartCount')
  if (countEl) countEl.textContent = getQuantidadeCarrinho()
}

// ============================================
// FUNÇÕES DE CHAT (COM BLOQUEIO)
// ============================================

async function enviarMensagem(destinatarioId, conteudo) {
  const user = await getCurrentUser()
  if (!user) {
    alert('Faça login para enviar mensagens')
    return false
  }

  // Bloqueia WhatsApp, telefone e email
  const palavrasProibidas = ['whatsapp', 'telefone', 'celular', '@gmail', '@hotmail', '@outlook', '@yahoo', 'zap']
  const conteudoLower = conteudo.toLowerCase()

  for (const palavra of palavrasProibidas) {
    if (conteudoLower.includes(palavra)) {
      alert('❌ Mensagem contém informação de contato proibida (WhatsApp, telefone, etc).')
      return false
    }
  }

  // Bloqueia números de telefone
  const telefoneRegex = /\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g
  if (telefoneRegex.test(conteudo)) {
    alert('❌ Não é permitido enviar números de telefone.')
    return false
  }

  const { data, error } = await supabaseClient
    .from('mensagens')
    .insert({
      remetente_id: user.id,
      destinatario_id: destinatarioId,
      conteudo: conteudo
    })
    .select()

  if (error) {
    alert('Erro ao enviar mensagem: ' + error.message)
    return false
  }

  return data[0]
}

// ============================================
// EXPORTAÇÃO DAS FUNÇÕES (para uso global)
// ============================================

window.supabaseClient = supabaseClient
window.login = login
window.loginComGoogle = loginComGoogle
window.loginComFacebook = loginComFacebook
window.cadastrarUsuario = cadastrarUsuario
window.logout = logout
window.getCurrentUser = getCurrentUser
window.verificarUsuarioLogado = verificarUsuarioLogado
window.registrarPrimeiroLogin = registrarPrimeiroLogin
window.getProducts = getProducts
window.getUserProducts = getUserProducts
window.criarProduto = criarProduto
window.atualizarProduto = atualizarProduto
window.deletarProduto = deletarProduto
window.getLoja = getLoja
window.atualizarLoja = atualizarLoja
window.ensureUserAndLoja = ensureUserAndLoja
window.ensureLoja = ensureLoja
window.getCategorias = getCategorias
window.getCursos = getCursos
window.getCursosDaLoja = getCursosDaLoja
window.getUserCursos = getUserCursos
window.getCurso = getCurso
window.criarCurso = criarCurso
window.atualizarCurso = atualizarCurso
window.deletarCurso = deletarCurso
window.getTopicosCurso = getTopicosCurso
window.criarTopicoCurso = criarTopicoCurso
window.deletarTopicoCurso = deletarTopicoCurso
window.registrarCompraCurso = registrarCompraCurso
window.getCompraCurso = getCompraCurso
window.adicionarAoCarrinho = adicionarAoCarrinho
window.removerDoCarrinho = removerDoCarrinho
window.atualizarQuantidade = atualizarQuantidade
window.getTotalCarrinho = getTotalCarrinho
window.getQuantidadeCarrinho = getQuantidadeCarrinho
window.enviarMensagem = enviarMensagem
window.carrinho = carrinho
