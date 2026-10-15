---
source: StudyBuddy demo corpus (original content)
topic: choosing k and evaluating clusters
---
# Choosing the Number of Clusters

## Why inertia alone is not enough

Inertia always goes down as k increases, because more centroids mean every point can sit closer to one. In the extreme, giving every point its own cluster makes inertia zero. So picking the k with the lowest inertia would always pick the largest k you try, which is useless.

## The elbow method

The elbow method plots inertia against k for a range of values. At first inertia falls steeply as each new cluster captures a real group. After a point the curve flattens, because extra clusters only split groups that already belong together. The value of k at the bend, the elbow, is a sensible choice. The elbow is not always sharp, so the method gives a guide rather than a firm answer.

## The silhouette score

The silhouette score measures how well each point fits its own cluster compared with the nearest other cluster. For one point it compares the average distance to points in its own cluster with the average distance to points in the next closest cluster. Scores range from minus one to one. A score near one means the point is well inside its cluster, a score near zero means it sits on a boundary, and a negative score suggests it may be in the wrong cluster. Averaging over all points and choosing the k with the highest average silhouette is a common alternative to the elbow method.

## Use domain knowledge

The numbers are only part of the story. If a marketing team can act on four customer segments but not on eleven, four may be the right answer even if a metric prefers eleven. Always look at what the clusters contain and whether they are useful for the task.
