Stellara_backend
🚀 Stellara Backend — Web3 Crypto Academy Server

Stellara Backend is the server-side application powering Stellara AI, a next-generation Web3 learning and social trading platform built on the Stellar blockchain ecosystem. It is designed for crypto learners and traders who need real-time communication, secure account systems, AI-assisted learning tools, and on-chain trading services.

This backend manages authentication, courses, rewards, social feeds, messaging, AI integrations, and blockchain interactions, while exposing REST APIs and WebSocket gateways consumed by the Stellara AI frontend.

🚀 Overview
Stellara AI is designed to educate, empower, and connect crypto users by combining:

A crypto learning academy with structured courses and quizzes
An AI-powered assistant with text and voice guidance
A social crypto network with posts, comments, and interactions
Real-time messaging for one-on-one and group discussions
On-chain trading tools integrated with Stellar wallets
Live market news and insights powered by AI
The backend is responsible for securely managing the core application logic, database interactions, and blockchain integrations.

🧠 Core Features
🤖 Stellara AI Assistant
Text & voice-based AI crypto mentor
Explains trading strategies, blockchain concepts, and Stellar-specific tools
Provides market insights & educational guidance (not financial advice)
🎓 Crypto Academy
Structured learning paths (Beginner → Pro)
Stellar & Soroban smart contract education
Interactive quizzes and progress tracking
🗣 Social Crypto Feed
Post updates, ideas, and market thoughts
Like, comment, repost (tweet-style)
Follow other traders & educators
💬 Community Chat
One-on-one messaging
Group discussions & learning channels
Trading & ecosystem-focused rooms
📈 Trading & Wallet
Trade Stellar-based assets
Freighter wallet integration
Portfolio overview & transaction history
📰 News & Market Intelligence
Real-time crypto news
Stellar ecosystem updates
Market trend summaries via AI
🛠 Technology Stack
Backend
NestJS – API framework
PostgreSQL – Relational database
Redis – Caching & real-time messaging
WebSocket Gateway – Real-time chat & feed
Blockchain
Stellar SDK & Horizon API
Soroban Smart Contracts
Freighter Wallet integration
AI & Voice
LLM API (OpenAI or equivalent)
Speech-to-Text (Whisper or similar)
Text-to-Speech (TTS)
Infrastructure
Docker for containerization
AWS / Railway / Render for backend hosting
Vercel for frontend deployment
💎 Why Stellara AI Works
Instantly signals AI intelligence
Strong connection to Stellar blockchain
Easy to market & brand
Scales to mobile apps, APIs, and future tools
Credible to investors and partners
⚡ Getting Started ✅ Requirements

Node.js v18+ PostgreSQL Redis npm or pnpm

📦 Installation git clone https://github.com/stellara-network/Stellara_Contracts
 cd Stellara_Contracts
 cd Backend
  npm install

🔐 Environment Setup

Create a .env file in the project root: PORT=3001 DATABASE_URL=postgresql://user:password@localhost:5432/stellara REDIS_URL=redis://localhost:6379 JWT_SECRET=your_jwt_secret STELLAR_NETWORK=testnet HORIZON_URL=https://horizon-testnet.stellar.org AI_API_KEY=your_llm_api_key

▶ Run Development Server npm run start:dev

▶ Run Development Server npm run start:dev

🧪 Testing npm run test npm run test:e2e

🤝 Contributing The first step is to Fork the repository then you Create a feature branch Commit your changes git pull latest changes to avoid conflicts Submit a pull request Issues and feature requests are welcome.