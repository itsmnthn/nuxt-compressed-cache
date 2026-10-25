<script setup lang="ts">
const route = useRoute('blog-slug')

const { data: post } = await useAsyncData(`post-${route.params.slug}`, () => Promise.resolve(
  route.params.slug === 'missing' ? undefined : { title: `Post ${route.params.slug}` },
))

if (!post.value) {
  throw createError({ status: 404, statusText: 'Post not found' })
}
</script>

<template>
  <article>{{ post?.title }}</article>
</template>
