# Website Screenshot Service

A service that takes screenshots of websites and applies visual styling.

## Setup

1. Clone this repository
2. Install dependencies: `pnpm install`
3. Create a `.env` file based on `.env.example`
4. Start the development server: `pnpm run dev`

## Configuration

Set the following environment variables in your `.env` file:

- `BROWSERBASE_API_KEY`: Your Browserbase API key
- `BROWSERBASE_PROJECT_ID`: Your Browserbase project ID
- `PORT`: (Optional) Port to run the server on (default: 3000)

## API Endpoints

### GET /

Returns a simple greeting message to confirm the server is running.

### GET /screenshot?url=https://example.com

Takes a screenshot of the specified URL and returns it as a PNG image.

## Technologies Used

- Node.js
- Hono (Web framework)
- Playwright (Browser automation)
- Canvas (Image processing)
- Browserbase (Browser as a service)