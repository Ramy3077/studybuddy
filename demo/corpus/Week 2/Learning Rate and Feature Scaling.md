---
source: StudyBuddy demo corpus (original content)
topic: learning rate and feature scaling
---
# Learning Rate and Feature Scaling

## Choosing the learning rate

The learning rate controls how big each gradient descent step is. If the learning rate is too small, training makes steady progress but needs a very large number of steps. If the learning rate is too large, the updates overshoot the minimum and the loss can bounce around or even grow without limit. A good first move is to try values spaced by factors of ten, such as 0.001, 0.01 and 0.1, and watch the loss curve.

## Reading the loss curve

Plot the training loss against the number of iterations. A healthy curve falls quickly at first and then flattens out. A curve that falls painfully slowly suggests the learning rate is too low. A curve that zigzags or climbs suggests the learning rate is too high.

## Learning rate schedules

Many training runs start with a larger learning rate and reduce it over time. Large early steps cover ground quickly, and smaller later steps let the parameters settle into the minimum instead of jumping around it. Common schedules drop the rate by a fixed factor every few epochs or decay it smoothly.

## Why feature scaling matters

When features have very different ranges, for example floor area in the thousands and number of bedrooms between one and five, the loss surface becomes a long narrow valley. Gradient descent then zigzags across the valley and moves slowly along it. Rescaling the features to similar ranges makes the valley rounder, so gradient descent can head more directly to the minimum.

## Two common scalers

Standardisation subtracts each feature's mean and divides by its standard deviation, so every feature ends up with mean zero and unit variance. Min-max scaling instead maps each feature into a fixed range, usually zero to one. Whichever method you use, compute the scaling statistics on the training set only and then apply the same transformation to the validation and test sets.
