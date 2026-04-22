import { createApp } from "./app.js";

const { app, port } = await createApp();

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
