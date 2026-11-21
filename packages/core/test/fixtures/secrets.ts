// 作り物の秘密の形の値。検査の道具に本物の秘密と見られないよう、頭と中身を分けて組む
const fake = (head: string, body: string): string => `${head}${body}`;

// 秘密の形のデータ（packages/contracts/data/secret-shapes.json）の各行に当たる値
export const SECRET_SAMPLES: Record<string, string> = {
  delegation_token: fake("ndfd_", "usr_x.dlg_y.EXAMPLE"),
  machine_token: fake("ndfm_", "team_x.mch_y.EXAMPLE"),
  jwt: fake("eyJ", "hbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln"),
  github_app_token: fake("ghs_", "EXAMPLE"),
  github_personal_token: fake("ghp_", "EXAMPLE"),
  github_oauth_token: fake("gho_", "EXAMPLE"),
  github_fine_grained_token: fake("github_pat_", "EXAMPLE"),
  private_key: fake("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEXAMPLE\n-----END RSA PRIVATE KEY-----"),
  url_with_credentials: fake("postgres://acme:", "example@db.example.com/acme"),
  aws_temporary_key: fake("ASIA", "EXAMPLE0EXAMPLE0"),
};

// 出力の文字列に秘密の値のどれかが（一部でも）残るか。頭と、頭を除いた中身の両方で探す
export function leakedSecrets(text: string): string[] {
  return Object.entries(SECRET_SAMPLES)
    .filter(([, value]) => text.includes(value) || text.includes(value.slice(0, 8)) || text.includes(value.slice(-8)))
    .map(([name]) => name);
}
