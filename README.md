<p align="center">
  <a href="https://github.com/scottzx/yima-crm">
    <img src="./docs/images/yima-logo-light.png" width="160px" alt="Yima CRM Logo" />
  </a>
</p>

<h1 align="center">Yima CRM</h1>

<p align="center">
  <b>面向咨询、销售与客户服务场景的现代智能化 CRM 系统</b>
  <br />
  <i>Built on <a href="https://github.com/twentyhq/twenty">Twenty</a> (AGPLv3)</i>
</p>

<p align="center">
  <a href="#-关于-yima-crm">关于项目</a> ·
  <a href="#-开源协议与致谢声明">开源声明</a> ·
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-核心能力">核心能力</a> ·
  <a href="#-技术架构">技术架构</a>
</p>

---

## 📖 关于 Yima CRM

**Yima CRM** 是专为具有深度洽谈与咨询属性行业（例如宠物医疗、生产制造、法律服务、美业连锁等）打造的智能化客户关系管理平台。

在常规业务推进中，顾问与客户的沟通至关重要。Yima CRM 围绕 **“触达 ➔ 沟通 ➔ 复盘 ➔ 赋能”** 的闭环展开：
1. **咨询与沟通沉淀**：结合电话与离线录音转写（ASR）技术，将沟通过程自动沉淀为结构化客户档案。
2. **需求提炼与方案定制**：深入分析客户潜在诉求，快速输出针对性销售方案。
3. **专业技能复盘与赋能**：协助专业技术人员（如宠物医生、制造工程师等）补足销售与商务沟通短板，提升转化率。

---

## ⚖️ 开源协议与致谢声明

- **上游项目致谢**：本项目基于优秀的开源项目 [Twenty](https://github.com/twentyhq/twenty) 进行二次开发与定制。我们由衷感谢 Twenty 核心团队及全体开源社区贡献者的付出。
- **商标与品牌规范**：依据 Twenty 官方 [Trademark Policy](https://github.com/twentyhq/twenty/blob/main/.github/TRADEMARK.md) 规定，本项目作为独立分支（Fork）采用自主品牌 **“Yima CRM”** 进行公开维护，并在此真实声明系统底层基于 Twenty 构建。
- **开源许可证**：本项目主体核心代码遵循 **GNU Affero General Public License v3.0 (AGPLv3)**。

---

## 🚀 快速开始

### 🐳 使用 Docker Compose 本地或私网拉起

1. **克隆仓库**：
   ```bash
   git clone https://github.com/scottzx/yima-crm.git
   cd yima-crm
   ```

2. **配置环境变量**：
   ```bash
   cp .env.example .env
   # 按需配置 ENCRYPTION_KEY、APP_SECRET 及 SERVER_URL
   ```

3. **启动服务**：
   ```bash
   docker compose up -d
   ```

4. **访问控制台**：
   - 浏览器打开 `http://localhost:3000`（或服务器局域网/Tailscale IP 地址）。
   - 完成管理员账号注册，即刻开始配置工作区与客户数据表。

---

## ✨ 核心能力

- **全定制数据建模**：支持作为代码定义对象（Object）、字段（Field）及关系视图。
- **GraphQL & REST API**：提供完善的现代接口，方便与呼叫中心、录音转写工具及第三方平台极速集成。
- **现代化组件与交互**：基于 React、NestJS、PostgreSQL 16、Redis 构建，界面极简优雅、流畅顺滑。
- **私有化与合规部署**：所有数据全本地存储于自建 PostgreSQL 实例中，杜绝客户商业隐私外泄。

---

<p align="center">
  Made with ❤️ by Scott & Yima Community · Powered by <a href="https://twenty.com">Twenty</a>
</p>
