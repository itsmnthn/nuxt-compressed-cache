<script setup lang="ts">
const renderedAt = new Date().toISOString()
</script>

<template>
  <main>
    <h1>nuxt-compressed-cache</h1>
    <p>Rendered at {{ renderedAt }}, check the <code>x-cache</code> response header.</p>
  </main>
</template>
