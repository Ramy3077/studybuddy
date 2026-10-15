# Demo corpus

These notes are original demo content written for the StudyBuddy public demo.
They are not taken from any university course, textbook or lecture slides.

The layout mirrors what the ingester expects from a notes vault:

```
Week N/<Topic>.md   -> a "notes" source for week N
```

This README sits at the top level, so the ingester ignores it.
The matching question bank is `demo/questions.json`. Every question in it
carries an evidence quote that must appear word for word in one of these notes,
or the importer drops it.
