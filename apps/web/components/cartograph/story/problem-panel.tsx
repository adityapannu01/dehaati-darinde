export function ProblemPanel() {
  return (
    <div className="story-panel mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
        The problem
      </p>
      <h2 className="text-foreground mt-3 text-2xl font-bold md:text-3xl">
        Two engineers map a system by voice. One says &ldquo;wait, change the Redis cache to
        MongoDB&rdquo; mid-sentence.
      </h2>
      <p className="text-muted-foreground mt-6 leading-7">
        A naive voice agent draws whatever the model decided to say — including the half of a
        sentence the user cut off. The shared canvas ends up with a node nobody in the room ever
        actually heard named. Nobody notices until the diagram is wrong in a meeting three days
        later.
      </p>
      <p className="text-foreground mt-6 font-medium">
        Cartograph draws only what was actually delivered as audio — never what the agent merely
        intended to say.
      </p>
    </div>
  );
}
