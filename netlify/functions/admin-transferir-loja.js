// ============================================
// Netlify Function: admin-transferir-loja
// Admin transfere uma loja para um usuário (com merge se necessário)
// e opcionalmente dá um plano patrocinado por X meses
// ============================================

const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_EMAIL = 'viniciusbirnecker@gmail.com'

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido' }
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey)
    const body = JSON.parse(event.body)

    // Verificar admin
    const authHeader = event.headers.authorization || ''
    const token = authHeader.replace('Bearer ', '')
    const { data: { user: adminUser }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !adminUser || adminUser.email !== ADMIN_EMAIL) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Acesso negado' }) }
    }

    const { loja_id, email_destino, plano, meses } = body

    if (!loja_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'ID da loja é obrigatório' }) }
    }
    if (!email_destino) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Email do destinatário é obrigatório' }) }
    }

    // Buscar a loja criada pelo admin
    const { data: lojaAdmin, error: lojaError } = await supabase
      .from('lojas')
      .select('*')
      .eq('id', loja_id)
      .eq('criada_por_admin', true)
      .single()

    if (lojaError || !lojaAdmin) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Loja não encontrada ou não é uma loja do admin' }) }
    }

    // Buscar o usuário destino pelo email
    const { data: userDestino, error: userError } = await supabase
      .from('users')
      .select('id, email, nome')
      .eq('email', email_destino.toLowerCase().trim())
      .single()

    if (userError || !userDestino) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Usuário não encontrado com esse email' }) }
    }

    // Verificar se o usuário destino já tem uma loja
    const { data: lojaDestino } = await supabase
      .from('lojas')
      .select('*')
      .eq('user_id', userDestino.id)
      .maybeSingle()

    if (lojaDestino) {
      // ===== MERGE: usuário já tem loja =====
      // 1. Mover todos os produtos da loja admin para a loja do usuário
      const { error: updateProdutos } = await supabase
        .from('produtos')
        .update({ loja_id: lojaDestino.id, user_id: userDestino.id })
        .eq('loja_id', lojaAdmin.id)

      if (updateProdutos) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao migrar produtos: ' + updateProdutos.message }) }
      }

      // 2. Mover cursos
      const { error: updateCursos } = await supabase
        .from('cursos')
        .update({ loja_id: lojaDestino.id })
        .eq('loja_id', lojaAdmin.id)

      if (updateCursos) {
        console.error('Erro ao migrar cursos:', updateCursos)
      }

      // 3. Atualizar loja destino com dados da loja admin, MAS preservar logo/banner
      const updatesLojaDestino = {
        nome_loja: lojaDestino.nome_loja || lojaAdmin.nome_loja,
        descricao: (lojaDestino.descricao && lojaDestino.descricao.trim()) ? lojaDestino.descricao : lojaAdmin.descricao,
        categoria: lojaDestino.categoria || lojaAdmin.categoria,
        instagram: lojaDestino.instagram || lojaAdmin.instagram,
        whatsapp: lojaDestino.whatsapp || lojaAdmin.whatsapp,
        ativa: true
        // NÃO sobrescreve: logo, banner, cor_destaque, cor_borda_logo, css_personalizado
      }

      const { error: updateLoja } = await supabase
        .from('lojas')
        .update(updatesLojaDestino)
        .eq('id', lojaDestino.id)

      if (updateLoja) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao atualizar loja destino: ' + updateLoja.message }) }
      }

      // 4. Deletar a loja admin (já foi mergeada)
      const { error: deleteLoja } = await supabase
        .from('lojas')
        .delete()
        .eq('id', lojaAdmin.id)

      if (deleteLoja) {
        console.error('Erro ao deletar loja admin após merge:', deleteLoja)
      }

      // 5. Aplicar plano patrocinado (se informado)
      if (plano && plano !== 'free' && meses > 0) {
        const expiracao = new Date()
        expiracao.setMonth(expiracao.getMonth() + meses)

        await supabase.from('users').update({
          plano: plano,
          plano_patrocinado: plano,
          plano_patrocinado_expiracao: expiracao.toISOString()
        }).eq('id', userDestino.id)

        await supabase.from('patrocinios').insert({
          loja_id: lojaDestino.id,
          user_id: userDestino.id,
          admin_id: adminUser.id,
          plano,
          meses
        })
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          merged: true,
          loja_id: lojaDestino.id,
          mensagem: 'Loja mesclada com sucesso! Produtos transferidos, branding do usuário preservado.'
        })
      }
    } else {
      // ===== TRANSFERÊNCIA DIRETA: usuário não tem loja =====
      const { error: updateLoja } = await supabase
        .from('lojas')
        .update({
          user_id: userDestino.id,
          criada_por_admin: false,
          ativa: true
        })
        .eq('id', lojaAdmin.id)

      if (updateLoja) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Erro ao transferir loja: ' + updateLoja.message }) }
      }

      // Atualizar user_id nos produtos também
      const { error: updateProdutos } = await supabase
        .from('produtos')
        .update({ user_id: userDestino.id })
        .eq('loja_id', lojaAdmin.id)

      if (updateProdutos) {
        console.error('Erro ao atualizar user_id nos produtos:', updateProdutos)
      }

      // Aplicar plano patrocinado (se informado)
      if (plano && plano !== 'free' && meses > 0) {
        const expiracao = new Date()
        expiracao.setMonth(expiracao.getMonth() + meses)

        await supabase.from('users').update({
          plano: plano,
          plano_patrocinado: plano,
          plano_patrocinado_expiracao: expiracao.toISOString()
        }).eq('id', userDestino.id)

        await supabase.from('patrocinios').insert({
          loja_id: lojaAdmin.id,
          user_id: userDestino.id,
          admin_id: adminUser.id,
          plano,
          meses
        })
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          merged: false,
          loja_id: lojaAdmin.id,
          mensagem: 'Loja transferida com sucesso!'
        })
      }
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
