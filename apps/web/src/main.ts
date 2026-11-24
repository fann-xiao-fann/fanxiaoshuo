import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import './styles/global.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 在挂载前同步落地一次主题（index.html 已先行处理首屏防闪白，这里用于校准 store 状态）。
useThemeStore(pinia).applyTheme();

app.use(router);
app.mount('#app');
