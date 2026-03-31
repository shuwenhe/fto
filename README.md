# fto

## 项目结构

- `frontend/` Next.js 前端（通过 `/fto` 访问）
- `backend/` Gin 后端（通过 `/fto/api` 访问）
- `scripts/` 自动提交/推送脚本

## 最小联调启动

1. 安装前端依赖

```bash
cd /app/fto
make frontend-install
```

2. 安装后端依赖

```bash
cd /app/fto
make backend-deps
```

3. 启动前后端（两个终端）

```bash
cd /app/fto
make frontend-dev
```

```bash
cd /app/fto
make backend-run
```

4. 另一个终端检查联通

```bash
cd /app/fto
make nginx-test
make nginx-reload
make backend-health
```

5. 浏览器访问

```text
http://111.202.231.146:8080/fto
```

## 代码更新自动提交到 GitHub

已提供自动化脚本：检测代码变更后自动提交，并自动推送到远端分支。

1. 启动自动提交/推送

```bash
cd /app/fto
make git-auto-start
```

2. 查看状态

```bash
cd /app/fto
make git-auto-status
```

3. 查看日志

```bash
cd /app/fto
make git-auto-log
```

4. 停止

```bash
cd /app/fto
make git-auto-stop
```

可选环境变量（启动前设置）：

```bash
export AUTO_COMMIT_INTERVAL_SEC=5
export AUTO_COMMIT_PUSH=1
export AUTO_COMMIT_PUSH_REMOTE=origin
export AUTO_COMMIT_PUSH_BRANCH=main
export AUTO_COMMIT_PREFIX="chore(auto)"
```

如果日志提示缺少 git 身份，请先设置：

```bash
git config user.name "Your Name"
git config user.email "you@example.com"
```

## 召回一致性回归检查

用于随机抽样 query，对比线上接口与本地双路召回排序 top-k 是否完全一致。

```bash
cd /app/fto
make compare-online-offline
```

也可直接执行并自定义参数：

```bash
cd /app/fto
node scripts/compare_online_offline.mjs --k 5 --sample 10 --seed 20260331 --base-url http://127.0.0.1/fto/api --verbose
```