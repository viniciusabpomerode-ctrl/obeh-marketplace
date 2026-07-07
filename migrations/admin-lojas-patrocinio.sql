-- ============================================
-- MIGRAÇÃO: PAINEL ADMIN DE LOJAS + PATROCÍNIO
-- Execute no SQL Editor do Supabase
-- ============================================

-- 1. Marcar lojas criadas pelo admin
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS criada_por_admin BOOLEAN DEFAULT false;

-- 2. Plano patrocinado pelo admin (com expiração)
ALTER TABLE users ADD COLUMN IF NOT EXISTS plano_patrocinado TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plano_patrocinado_expiracao TIMESTAMPTZ;

-- 3. Tabela de registro de patrocínios (auditoria)
CREATE TABLE IF NOT EXISTS patrocinios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  loja_id UUID REFERENCES lojas(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  plano TEXT NOT NULL DEFAULT 'pro',
  meses INTEGER NOT NULL DEFAULT 1,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Índices
CREATE INDEX IF NOT EXISTS idx_lojas_criada_por_admin ON lojas(criada_por_admin) WHERE criada_por_admin = true;
CREATE INDEX IF NOT EXISTS idx_users_plano_patrocinado ON users(plano_patrocinado_expiracao) WHERE plano_patrocinado IS NOT NULL;
