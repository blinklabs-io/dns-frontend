# dns-frontend

A Cardano SLD (Second-Level Domain) minting dApp built with React, Vite, TypeScript, Tailwind CSS, and Cloudflare Pages Functions.

## Tech Stack

- **React 19** - UI library
- **TypeScript** - Type-safe JavaScript
- **Vite** - Build tool and frontend dev server
- **Cloudflare Pages Functions** - Same-origin API under `/api/transactions`
- **Tailwind CSS 4** - Utility-first CSS framework
- **ESLint** - Code linting
- **React Compiler** - Experimental React optimization

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm or yarn

### Installation

Install dependencies:
npm install

### Development

Start the development server:
npm run dev

The frontend will be available at <http://localhost:5173>.

For a local production-style run with the frontend and Pages Functions on the same origin:
npm run build
npm run functions:dev

The Pages app and API will be available at <http://localhost:8788>.

### Build

Build for production:
npm run build

### Preview Production Build

Preview the production build locally:
npm run preview

### Linting

Run ESLint:
npm run lint

## Project Structure

- `src/` - React application and API client
- `functions/api/transactions/` - Cloudflare Pages Function routes
- `functions/lib/` - Shared API services and blockchain provider utilities

## Configuration

- **TypeScript**: Configured with strict mode and modern ES2022+ features
- **ESLint**: Uses recommended configs with React Hooks and React Refresh plugins
- **Vite**: Includes React plugin with experimental React Compiler support
- **Tailwind CSS**: v4 with PostCSS integration
