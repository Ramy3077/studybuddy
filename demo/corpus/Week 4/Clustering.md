---
source: StudyBuddy demo corpus (original content)
topic: k-means clustering
---
# Clustering

## Unsupervised learning

Clustering is an unsupervised learning task: the data has no labels, and the goal is to group similar examples together. Customer segmentation, grouping news articles by topic and compressing the colours in an image are all common uses. Because there are no labels, there is no single correct answer to compare against.

## The k-means algorithm

K-means splits the data into k clusters, where k is chosen in advance. Each cluster is represented by a centroid, which is the mean of the points assigned to it. The algorithm starts by placing k centroids, then alternates between two steps until the assignments stop changing.

In the assignment step, every point is assigned to its nearest centroid, usually by Euclidean distance. In the update step, each centroid is moved to the mean of the points now assigned to it. Each round can only lower or keep the total within-cluster squared distance, so the algorithm always converges.

## What k-means is minimising

K-means minimises the within-cluster sum of squares, also called inertia. This is the sum, over all points, of the squared distance from each point to the centroid of its cluster. Lower inertia means tighter clusters.

## Initialisation matters

K-means only finds a local minimum, and the result depends on where the centroids start. A bad start can leave two centroids sharing one natural group while another group is split. The usual fixes are to run the algorithm several times with different random starts and keep the run with the lowest inertia, or to use the k-means++ initialisation, which spreads the starting centroids far apart.

## Limitations

K-means assumes clusters are roughly round and similar in size, because it relies on distance to a single centre. It struggles with elongated or nested shapes and is pulled around by outliers. Since it uses distances, features should be scaled to similar ranges before clustering.
