# Используем легкий веб-сервер Nginx
FROM nginx:alpine

# Копируем все файлы нашего приложения в папку Nginx
COPY . /usr/share/nginx/html

# Открываем 80 порт
EXPOSE 80

# Запускаем Nginx
CMD ["nginx", "-g", "daemon off;"]