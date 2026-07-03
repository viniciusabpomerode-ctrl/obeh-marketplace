// ============================================
// STRIPE - ASSINATURAS (Basic / Pro / Ultra)
// ============================================
// Importante: assinaturas de plano são cobradas via Stripe.
// A compra de produtos artesanais NÃO passa pelo Stripe — o pagamento
// vai direto para o Mercado Pago de cada artesão (ver checkout do carrinho).

async function redirectToCheckout(plano) {
  const planosValidos = ['basic', 'pro', 'ultra']
  if (!planosValidos.includes(plano)) {
    alert('❌ Plano inválido.')
    return
  }

  const user = await getCurrentUser()
  if (!user) {
    alert('⚠️ Você precisa estar logado para assinar um plano.')
    window.location.href = 'login.html'
    return
  }

  try {
    const resposta = await fetch('/.netlify/functions/create-subscription-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plano,
        userId: user.id,
        email: user.email,
        successUrl: window.location.origin + window.location.pathname + '?assinatura=sucesso&plano=' + plano,
        cancelUrl: window.location.origin + window.location.pathname + '?assinatura=cancelada'
      })
    })

    const dados = await resposta.json()

    if (!resposta.ok || !dados.url) {
      throw new Error(dados.error || 'Não foi possível iniciar a assinatura.')
    }

    window.location.href = dados.url
  } catch (err) {
    console.error('Erro ao redirecionar para o Stripe:', err)
    alert('❌ Erro ao iniciar a assinatura: ' + err.message)
  }
}

// ===== CONFIRMA ASSINATURA AO VOLTAR DO STRIPE =====
async function confirmarAssinaturaPendente() {
  const params = new URLSearchParams(window.location.search)
  if (params.get('assinatura') !== 'sucesso') return

  const plano = params.get('plano')
  const planosValidos = ['basic', 'pro', 'ultra']
  if (!plano || !planosValidos.includes(plano)) return

  const user = await getCurrentUser()
  if (!user) return

  try {
    await supabaseClient.from('users').update({ plano }).eq('id', user.id)
    await supabaseClient.from('assinaturas').insert({ user_id: user.id, plano, status: 'ativa' })
    alert('✅ Assinatura confirmada! Seu plano agora é ' + plano.toUpperCase() + '.')
  } catch (err) {
    console.error('Erro ao confirmar assinatura:', err)
  }

  // limpa os parâmetros da URL
  window.history.replaceState({}, document.title, window.location.pathname)
}

window.redirectToCheckout = redirectToCheckout
window.confirmarAssinaturaPendente = confirmarAssinaturaPendente
