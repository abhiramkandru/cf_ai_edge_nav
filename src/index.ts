/// <reference types="@cloudflare/workers-types" />
type Ai = any;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> 
  {
    const url = new URL(request.url);

    // Route: /api/chat
if (url.pathname === "/api/chat") 
{
  try 
  {
    console.log("AI binding:", typeof env.AI);
    const prompt = "Say hello from the Cloudflare edge!";
const response = await env.AI.run(
  "@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
  { prompt }
);



    return new Response(
      JSON.stringify({
        status: "ok",
        model_reply: response.result?.response ?? "(no text)"
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } 
catch (err) {
  console.error("AI error:", err);
  return new Response(
    JSON.stringify({ status: "error", message: String(err) }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}

}


    // Default route
    return new Response("Edge Navigator Worker running", 
    { 
      headers: { "Content-Type": "text/plain" } 
    });
  },
};

interface Env 
{
    AI: Ai;
  // We'll add Durable Objects, Workflows, etc. here later
}
