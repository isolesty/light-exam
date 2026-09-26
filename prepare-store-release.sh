#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法：$0 <新版本号，例如 1.0.2>" >&2
  exit 2
fi

VERSION=$1
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+$'; then
  echo "版本号格式无效" >&2
  exit 2
fi

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_DIR"
CLI=${LZC_CLI:-lzc-cli}
IMAGE_SOURCE=${IMAGE_SOURCE:-node:22-alpine}

echo "复制 $IMAGE_SOURCE 到懒猫官方镜像仓库……"
COPY_OUTPUT=$("$CLI" appstore copy-image "$IMAGE_SOURCE")
printf '%s\n' "$COPY_OUTPUT"
IMAGE_REF=$(printf '%s\n' "$COPY_OUTPUT" | sed -n 's/.*\(registry\.lazycat\.cloud\/[^[:space:]]*\).*/\1/p' | tail -n 1)
if [ -z "$IMAGE_REF" ]; then
  echo "未取得官方镜像地址；未更改项目文件" >&2
  exit 1
fi

node - "$IMAGE_REF" "$VERSION" <<'JS'
const fs = require('node:fs');
const [image, version] = process.argv.slice(2);
const manifest = fs.readFileSync('lzc-manifest.yml', 'utf8');
const pkg = fs.readFileSync('package.yml', 'utf8');
if (!/^  image: .+$/m.test(manifest) || !/^version: \d+\.\d+\.\d+$/m.test(pkg)) throw Error('清单结构与预期不符');
fs.writeFileSync('lzc-manifest.yml', manifest.replace(/^  image: .+$/m, `  image: ${image}`));
fs.writeFileSync('package.yml', pkg.replace(/^version: \d+\.\d+\.\d+$/m, `version: ${version}`));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
packageJson.version = version;
fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
JS

"$CLI" project release -o release/light-exam.lpk
"$CLI" lpk info release/light-exam.lpk
echo "正式包已准备。完成实机验收后执行：$CLI appstore publish release/light-exam.lpk"
