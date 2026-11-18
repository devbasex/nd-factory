# セキュリティの方針

nd-factory の脆弱性の報告の受け方を定める。

## 対象

| 対象 | 扱い |
| --- | --- |
| このリポジトリの `main` のコード（画面・API・形の正本・CDK のスタック・設置のコマンド） | 受け付ける |
| リリースの版 | まだ出していない。版を出したら、この表に受け付ける版を足す |
| 自分で設置した環境の設定・AWS のアカウントの設定 | 受け付けない。設置した人の管理の範囲である |
| 依存するライブラリそのものの脆弱性 | そのライブラリの提供元へ報告する。このリポジトリでの使い方に起因する問題は受け付ける |

## 報告の仕方

**公開の課題・Pull Request・議論に書かない。** 直す前に手口が広まるためである。

1. このリポジトリの「Security」タブを開き、「Report a vulnerability」から非公開で報告する（[GitHub の手順](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)）
2. 次を書く
   - 影響を受ける場所（ファイルのパス・API の経路・画面）
   - 再現の手順と、確かめたコミット
   - 想定する影響（読める・書ける・権限を越えられる範囲）
3. 報告には作り物の値だけを使い、実在のアカウント ID・秘密の値・個人情報を書かない

## 受け取った後

- 受け取ったことを、報告の場所で返す
- 直すまでは非公開のまま扱い、直した後に security advisory として公開する
- 報告者が望めば、advisory に名前を載せる
