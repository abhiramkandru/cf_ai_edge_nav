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

  const response = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say hello from the edge!" }
      ]
    }
  );

  console.log("Full AI response:", JSON.stringify(response));

  const reply =
    response.response ||
    response.output_text ||
    (response.output?.[0]?.content?.[0]?.text ?? "(no text)");


  return new Response(
    JSON.stringify({
      status: "ok",
      model_reply: reply
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
catch (err)
{
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
