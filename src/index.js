const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");

const prisma = new PrismaClient();
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Setup multer for image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// More secure version with some basic protections
app.use(
  "/uploads",
  (req, res, next) => {
    // Prevent directory traversal
    if (req.url.includes("..")) {
      return res.status(403).send("Forbidden");
    }
    next();
  },
  express.static("uploads")
);
//slugggg generater
const generateUserSlug = (name) => {
  //from the internet
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // remove weird characters (like #$%!@)
    .replace(/\s+/g, "-"); // replace spaces with dashes
};

app.get("/", (req, res) => {
  //so when the user go the home page his roll will be a buyer and not a seller so we'll just display the products for now
  res.redirect("/products");
});

app.get("/products", async (req, res) => {
  const products = await prisma.product.findMany();
  res.json(products);
});

app.get("/products/:id", async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
    });
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    console.log(product);
    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch product" });
  }
});
// Signup Endpoint
app.post("/signup", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    // Check if user exists
    const existingUser = await prisma.users.findFirst({
      where: { OR: [{ email }, { phone }] },
    });

    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const slug = generateUserSlug(name);

    const newUser = await prisma.users.create({
      data: {
        slug,
        email,
        phone,
        name,
        password: hashedPassword,
        role: "CUSTOMER",
        locale: "en",
        avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(
          name
        )}`, // 🔥 FREE avatar the avatar shit is ai because its a bitch
      },
    });
    const token = jwt.sign(
      //this is form the internet
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.status(200).json({
      success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
        avatar: newUser.avatar, // 🟢 send it if it's needed
      },
      token,
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Login Endpoint
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.users.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Compare passwords
    const passwordValid = await bcrypt.compare(password, user.password);
    console.log("Password valid:", passwordValid);

    if (passwordValid) {
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role }, // Fixed: was using newUser instead of user
        process.env.JWT_SECRET,
        { expiresIn: "24h" }
      );
      res.status(200).json({
        success: true,
        user: {
          id: user.id, // Fixed: was using newUser instead of user
          email: user.email,
          name: user.name,
          role: user.role,
          avatar: user.avatar,
        },
        token,
      });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1]; // Bearer token

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Add user info to request, if its valed it decodes the users info
    next(); //to noootttt sttoppp
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// PATCH route to upgrade user to seller AND create seller profile
app.patch("/become-seller", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId; // Get from verified token
    const {
      business_name,
      business_type,
      tax_id,
      business_address,
      business_phone,
      business_email,
    } = req.body;

    // Validate required fields
    if (!business_name) {
      return res.status(400).json({ error: "Business name is required" });
    }

    // Check if user exists and is currently a customer
    const existingUser = await prisma.users.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (existingUser.role !== "CUSTOMER") {
      return res.status(400).json({
        error: "User is already a seller or has invalid role",
      });
    }

    // Check if seller profile already exists
    const existingProfile = await prisma.sellerProfile.findUnique({
      where: { user_id: userId },
    });

    if (existingProfile) {
      return res.status(400).json({ error: "Seller profile already exists" });
    }

    // Use Prisma transaction to do both operations atomically
    const result = await prisma.$transaction(async (prisma) => {
      // 1. Update user role to SELLER
      const updatedUser = await prisma.users.update({
        where: { id: userId },
        data: {
          role: "SELLER",
        },
      });

      // 2. Create seller profile
      const newSellerProfile = await prisma.sellerProfile.create({
        data: {
          user_id: userId,
          business_name,
          business_type,
          tax_id,
          business_address,
          business_phone,
          business_email,
          commission_rate: 0.05, // 5% default
          status: "PENDING", // Needs approval
          total_sales: 0,
          total_orders: 0,
          rating_count: 0,
        },
      });

      return { updatedUser, newSellerProfile };
    });

    // Generate new token with updated role
    const newToken = jwt.sign(
      {
        userId: result.updatedUser.id,
        email: result.updatedUser.email,
        role: result.updatedUser.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "100h" }
    );

    res.status(200).json({
      success: true,
      message:
        "Successfully applied to become a seller! Your application is pending approval.",
      user: {
        //this user will be send to forntend to give new info abt the user
        id: result.updatedUser.id,
        email: result.updatedUser.email,
        name: result.updatedUser.name,
        role: result.updatedUser.role,
        avatar: result.updatedUser.avatar,
      },
      sellerProfile: {
        //this for the forntend to use the new "sellerprofile" info to make some goodes
        id: result.newSellerProfile.id,
        business_name: result.newSellerProfile.business_name,
        status: result.newSellerProfile.status,
        commission_rate: result.newSellerProfile.commission_rate,
      },
      token: newToken, //changing the token so the brawser know that the user is a seller now
    });
  } catch (error) {
    console.error("Become seller error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

//middleware to check if the user is a seller role...
const requireSeller = (req, res, next) => {
  if (req.user.role !== "SELLER") {
    return res.status(403).json({ error: "Seller access required" });
  }
  next();
};

// ============= SELLER DASHBOARD ROUTES =============

// GET: Seller Dashboard Overview
app.get("/seller-dashboard", verifyToken, requireSeller, async (req, res) => {
  try {
    const sellerId = req.user.userId;

    // Get seller profile with stats
    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { user_id: sellerId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });

    if (!sellerProfile) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    // plus thing to see the totle sellers products
    const productCount = await prisma.product.count({
      where: { seller_id: sellerId },
    });
    const products = await prisma.product.findMany({
      where: { seller_id: sellerId },
      orderBy: { created_at: "desc" },
      take: 10, // just latest 10 for example
    });

    // Get recent orders
    const recentOrders = await prisma.orderLine.findMany({
      where: {
        product: {
          seller_id: sellerId,
        },
      },
      include: {
        product: {
          select: {
            title: true,
            picture: true,
            price: true,
          },
        },
        order: {
          include: {
            user: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: {
        order: {
          created_at: "desc",
        },
      },
      take: 10,
    });

    const dashboardData = {
      seller: sellerProfile,
      stats: {
        totalProducts: productCount,
        totalSales: sellerProfile.total_sales,
        totalOrders: sellerProfile.total_orders,
        rating: sellerProfile.rating,
        ratingCount: sellerProfile.rating_count,
      },
      recentOrders,
      products,
    };

    res.json({ success: true, data: dashboardData });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post(
  "/add-product",
  verifyToken,
  requireSeller,
  upload.single("picture"),
  async (req, res) => {
    try {
      if (!req.body) {
        return res.status(400).json({
          error:
            "Request body is missing. Make sure you're sending form data properly.",
        });
      }

      const {
        title,
        summary,
        description,
        price,
        discount_type,
        discount_value,
        tags,
        stock_quantity,
      } = req.body;

      if (!title || !description || !price || !stock_quantity) {
        return res.status(400).json({
          error:
            "Missing required fields: title, description, price, and stock_quantity are required.",
        });
      }

      const picture = req.file ? `/uploads/${req.file.filename}` : "";

      // Parse numeric fields
      const parsedPrice = parseFloat(price);
      const parsedDiscountValue = discount_value
        ? parseFloat(discount_value)
        : 0;
      const parsedStockQuantity = parseInt(stock_quantity);

      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ error: "Invalid price value" });
      }

      if (isNaN(parsedStockQuantity) || parsedStockQuantity < 0) {
        return res.status(400).json({ error: "Invalid stock quantity" });
      }

      // Get or create default category
      let defaultCategory = await prisma.category.findFirst({
        where: { slug: "uncategorized" },
      });

      if (!defaultCategory) {
        defaultCategory = await prisma.category.create({
          data: {
            slug: "uncategorized",
            name: "Uncategorized",
            description: "Default category for uncategorized products",
            tags: ["default"],
          },
        });
      }

      const newProduct = await prisma.product.create({
        data: {
          seller_id: req.user.userId,
          category_id: defaultCategory.id, // Use default category
          title,
          summary: summary || "",
          description,
          price: parsedPrice,
          discount_type: discount_type || "none",
          discount_value: parsedDiscountValue,
          tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
          stock_quantity: parsedStockQuantity,
          picture,
        },
      });

      res.status(200).json({ success: true, product: newProduct });
    } catch (error) {
      console.error("Add product error:", error);

      if (error.code === "P2002") {
        return res
          .status(409)
          .json({ error: "Product with this title already exists" });
      }

      if (error.code === "P2003") {
        return res
          .status(400)
          .json({ error: "Invalid category_id or seller_id" });
      }

      res
        .status(500)
        .json({ error: "Something went wrong while creating the product" });
    }
  }
);
app.patch(
  "/edit-product/:id",
  verifyToken,
  requireSeller,
  upload.single("picture"),
  async (req, res) => {
    try {
      const product_id = req.params.id;

      if (!req.body) {
        return res.status(400).json({
          error:
            "Request body is missing. Make sure you're sending form data properly.",
        });
      }

      const {
        title,
        summary,
        description,
        price,
        discount_type,
        discount_value,
        tags,
        stock_quantity,
      } = req.body;

      if (!title || !description || !price || !stock_quantity) {
        return res.status(400).json({
          error:
            "Missing required fields: title, description, price, and stock_quantity are required.",
        });
      }

      // Check if the product exists and belongs to the seller
      const existingProduct = await prisma.product.findFirst({
        where: {
          id: product_id,
          seller_id: req.user.userId,
        },
      });

      if (!existingProduct) {
        return res.status(404).json({
          error: "Product not found or you don't have permission to edit it.",
        });
      }

      // Parse numeric fields
      const parsedPrice = parseFloat(price);
      const parsedDiscountValue = discount_value
        ? parseFloat(discount_value)
        : 0;
      const parsedStockQuantity = parseInt(stock_quantity);

      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ error: "Invalid price value" });
      }
      if (isNaN(parsedStockQuantity) || parsedStockQuantity < 0) {
        return res.status(400).json({ error: "Invalid stock quantity" });
      }

      // Only update picture if a new file was uploaded
      const updateData = {
        title,
        summary: summary || "",
        description,
        price: parsedPrice,
        discount_type: discount_type || "none",
        discount_value: parsedDiscountValue,
        tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
        stock_quantity: parsedStockQuantity,
      };

      // Add picture to update data only if a new file was uploaded
      if (req.file) {
        updateData.picture = `/uploads/${req.file.filename}`;
      }

      const updatedProduct = await prisma.product.update({
        where: { id: product_id },
        data: updateData,
      });

      res.status(200).json({ success: true, product: updatedProduct });
    } catch (error) {
      console.error("Edit product error:", error);
      if (error.code === "P2002") {
        return res
          .status(409)
          .json({ error: "Product with this title already exists" });
      }
      if (error.code === "P2025") {
        return res.status(404).json({ error: "Product not found" });
      }
      res
        .status(500)
        .json({ error: "Something went wrong while updating the product" });
    }
  }
);
app.delete(
  "/delete-product/:id",
  verifyToken,
  requireSeller,
  async (req, res) => {
    const { id } = req.params;
    try {
      await prisma.product.delete({
        where: { id },
      });
      res.status(200).json({ message: "Product deleted successfully!" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to delete product" });
    }
  }
);

// FIXED VERSION:
const getOptionalUser = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } else {
      req.user = null;
    }
  } catch {
    req.user = null;
  }
  next();
};
app.post(
  "/add-to-cart/:id", // id = product_id
  getOptionalUser,
  async (req, res) => {
    const user_id = req.user?.userId;
    const product_id = req.params.id;
    const { quantity = 1 } = req.body; // Default to 1 if not provided

    try {
      // Input validation
      if (!user_id) {
        // Changed error message for clarity
        return res.status(401).json({
          success: false,
          error: "Authentication required. Please log in to add items to cart.",
        });
      }
      if (!product_id) {
        return res.status(400).json({
          success: false,
          error: "Product ID is missing from the request.",
        });
      }
      // Ensure quantity is a number and within a reasonable range
      const parsedQuantity = parseInt(quantity, 10);
      if (isNaN(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 100) {
        return res.status(400).json({
          success: false,
          error: "Quantity must be a number between 1 and 100.",
        });
      }

      // Use a Prisma transaction to ensure atomicity and prevent race conditions
      const result = await prisma.$transaction(async (tx) => {
        // 1. Check if product exists and get its current price and stock
        const product = await tx.product.findUnique({
          where: { id: product_id },
          select: {
            id: true,
            price: true,
            stock_quantity: true,
            title: true,
            discount_type: true,
            discount_value: true,
            status: true, // Also check product status
          },
        });

        if (!product) {
          throw new Error("Product not found."); // Throw error for transaction rollback
        }

        // Check product status before adding to cart
        if (product.status !== "ACTIVE") {
          throw new Error(
            `Product "${product.title}" is not available for purchase (Status: ${product.status}).`
          );
        }

        // 2. Calculate the actual price (including discounts)
        let actualPrice = product.price;
        if (product.discount_type === "percent" && product.discount_value > 0) {
          actualPrice = product.price * (1 - product.discount_value / 100);
        } else if (
          product.discount_type === "amount" &&
          product.discount_value > 0
        ) {
          actualPrice = product.price - product.discount_value;
        }
        // Ensure price doesn't go below zero
        actualPrice = Math.max(0, actualPrice);

        // 3. Find or create active cart for user
        let cart = await tx.cart.findFirst({
          where: {
            created_by: user_id,
          },
        });

        // If cart exists but status is not ACTIVE, update it to ACTIVE
        if (cart && cart.status !== "ACTIVE") {
          cart = await tx.cart.update({
            where: { id: cart.id },
            data: { status: "ACTIVE" },
          });
        }

        // If no cart exists, create one
        if (!cart) {
          cart = await tx.cart.create({
            data: {
              created_by: user_id,
              status: "ACTIVE",
            },
          });
        }

        // If no active cart exists, create one
        if (!cart) {
          cart = await tx.cart.create({
            data: {
              created_by: user_id,
              status: "ACTIVE",
            },
          });
        }

        let cartItem;
        let message;

        // 4. Try to find an existing cart item for this product in this cart
        const existingItem = await tx.cartItem.findFirst({
          where: {
            cart_id: cart.id,
            product_id: product_id,
          },
        });

        if (existingItem) {
          const newQuantity = existingItem.quantity + parsedQuantity;

          // Check if new quantity exceeds stock
          if (newQuantity > product.stock_quantity) {
            throw new Error(
              `Cannot add ${parsedQuantity} items. Adding this would exceed available stock. Current in cart: ${existingItem.quantity}, Available: ${product.stock_quantity}.`
            );
          }

          // Update existing cart item
          cartItem = await tx.cartItem.update({
            where: { id: existingItem.id },
            data: {
              quantity: newQuantity,
              price: actualPrice, // Update price in case it changed
            },
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  picture: true,
                  stock_quantity: true,
                },
              },
            },
          });
          message = `Cart updated! Quantity increased to ${newQuantity}.`;
        } else {
          // Check if initial quantity exceeds stock for a new item
          if (parsedQuantity > product.stock_quantity) {
            throw new Error(
              `Cannot add ${parsedQuantity} items. Only ${product.stock_quantity} available.`
            );
          }

          // Create new cart item
          cartItem = await tx.cartItem.create({
            data: {
              cart_id: cart.id,
              product_id: product_id,
              quantity: parsedQuantity,
              price: actualPrice,
            },
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  picture: true,
                  stock_quantity: true,
                },
              },
            },
          });
          message = "Product added to cart successfully.";
        }

        // 5. Get updated cart summary (after item addition/update)
        const cartSummary = await tx.cart.findUnique({
          where: { id: cart.id },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    title: true,
                    picture: true,
                  },
                },
              },
            },
            _count: {
              select: { items: true },
            },
          },
        });

        // Calculate cart totals
        const totalItems = cartSummary.items.reduce(
          (sum, item) => sum + item.quantity,
          0
        );
        const totalPrice = cartSummary.items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0
        );

        return {
          cartItem,
          cartSummary: {
            id: cart.id,
            totalItems,
            totalPrice: parseFloat(totalPrice.toFixed(2)),
            itemCount: cartSummary._count.items,
          },
          message,
          status: existingItem ? 200 : 201, // Return appropriate status code
        };
      });

      // Send success response
      return res.status(result.status).json({
        success: true,
        message: result.message,
        data: {
          cartItem: result.cartItem,
          cartSummary: result.cartSummary,
        },
      });
    } catch (err) {
      console.error("Error adding to cart:", err.message); // Log the specific error message

      // Handle specific errors for better client feedback
      if (err.message.includes("Product not found")) {
        return res.status(404).json({ success: false, error: err.message });
      }
      if (err.message.includes("Insufficient stock")) {
        return res.status(400).json({ success: false, error: err.message });
      }
      if (err.message.includes("not available for purchase")) {
        return res.status(400).json({ success: false, error: err.message });
      }
      // For the unique constraint error (P2002), it should now be handled by the transaction's rollback
      // if it somehow still occurs due to a race condition *before* the unique constraint is applied,
      // but with the unique constraint and transaction, this specific error code should be less frequent.

      return res.status(500).json({
        success: false,
        error: "Failed to add product to cart. Please try again.",
      });
    }
  }
);
// GET /cart
app.get("/cart", getOptionalUser, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Step 1: Find the user's cart
    const cart = await prisma.cart.findFirst({
      where: {
        created_by: user.userId,
      },
    });

    if (!cart) {
      return res.status(404).json({ error: "Cart not found" });
    }

    // Step 2: Get the cart items + product info
    const cartItems = await prisma.cartItem.findMany({
      //this is the most imp. thing
      where: {
        cart_id: cart.id,
      },
      include: {
        product: true, // Include full product info
      },
    });
    return res.json({ items: cartItems });
  } catch (err) {
    console.error("Error fetching cart items:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

app.delete("/cart-item/:id", async (req, res) => {
  const itemId = req.params.id;
  try {
    await prisma.cartItem.delete({
      where: { id: itemId },
    });
    res.json({ message: "Item deleted!" });
  } catch (err) {
    res.status(500).json({ error: "Couldn't delete item" });
  }
});

app.post("/checkout", getOptionalUser, async (req, res) => {
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "User must be logged in to checkout",
    });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Find the user's active cart with all items
      const activeCart = await tx.cart.findFirst({
        where: {
          created_by: userId,
          status: "ACTIVE",
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  price: true,
                  stock_quantity: true,
                  status: true,
                  discount_type: true,
                  discount_value: true,
                },
              },
            },
          },
        },
      });

      if (!activeCart) {
        throw new Error("No active cart found for this user.");
      }

      if (activeCart.items.length === 0) {
        throw new Error("Cart is empty.");
      }

      // 2. Validate each cart item and prepare for order creation
      const orderItems = [];
      let totalOrderAmount = 0;

      for (const cartItem of activeCart.items) {
        const product = cartItem.product;

        // Check product status
        if (product.status !== "ACTIVE") {
          throw new Error(
            `Product "${product.title}" is not available for purchase (Status: ${product.status}).`
          );
        }

        // Check stock availability
        if (product.stock_quantity < cartItem.quantity) {
          throw new Error(
            `Insufficient stock for "${product.title}". Only ${product.stock_quantity} available, but ${cartItem.quantity} requested.`
          );
        }

        // Calculate current price (in case prices changed since adding to cart)
        let currentPrice = product.price;
        if (product.discount_type === "percent" && product.discount_value > 0) {
          currentPrice = product.price * (1 - product.discount_value / 100);
        } else if (
          product.discount_type === "amount" &&
          product.discount_value > 0
        ) {
          currentPrice = product.price - product.discount_value;
        }
        currentPrice = Math.max(0, currentPrice);

        // Use the price from cart (when item was added) for consistency
        const itemTotal = cartItem.price * cartItem.quantity;
        totalOrderAmount += itemTotal;

        orderItems.push({
          product_id: product.id,
          quantity: cartItem.quantity,
          price: cartItem.price, // Use price from when item was added to cart
          itemTotal: itemTotal,
          newStockQuantity: product.stock_quantity - cartItem.quantity,
        });
      }

      // 3. Create the order
      const order = await tx.order.create({
        data: {
          user_id: userId,
        },
      });

      // 4. Create order lines and update product stock
      const orderLines = [];
      for (const orderItem of orderItems) {
        // Create order line
        const orderLine = await tx.orderLine.create({
          data: {
            order_id: order.id,
            product_id: orderItem.product_id,
            price: orderItem.price,
            quantity: orderItem.quantity,
          },
        });
        orderLines.push(orderLine);

        // Update product stock
        await tx.product.update({
          where: { id: orderItem.product_id },
          data: {
            stock_quantity: orderItem.newStockQuantity,
            status:
              orderItem.newStockQuantity === 0 ? "OUT_OF_STOCK" : undefined,
          },
        });
      }
      // Calculate and update seller statistics for each product's seller
      const sellerStats = new Map(); // Track seller updates

      for (const orderLine of orderLines) {
        // Get the product's seller info
        const product = await tx.product.findUnique({
          where: { id: orderLine.product_id },
          select: { seller_id: true },
        });

        if (!product.seller_id) continue;

        // Calculate line total
        const lineTotal = orderLine.price * orderLine.quantity;

        // Update seller statistics tracking
        if (!sellerStats.has(product.seller_id)) {
          sellerStats.set(product.seller_id, {
            total_sales: lineTotal,
            total_orders: 1,
          });
        } else {
          const stats = sellerStats.get(product.seller_id);
          stats.total_sales += lineTotal;
          stats.total_orders += 1;
        }
      }

      // Update seller profiles with new statistics
      for (const [sellerId, stats] of sellerStats) {
        await tx.sellerProfile.update({
          where: { user_id: sellerId },
          data: {
            total_sales: { increment: stats.total_sales },
            total_orders: { increment: stats.total_orders },
          },
        });
      }

      // 5. Clear the cart
      await tx.cartItem.deleteMany({
        where: {
          cart_id: activeCart.id,
        },
      });

      // 6. Update cart status
      await tx.cart.update({
        where: { id: activeCart.id },
        data: {
          status: "ORDERED",
        },
      });

      return {
        order: {
          ...order,
          total_amount: totalOrderAmount,
        },
        orderLines,
        itemCount: orderItems.length,
        totalItems: orderItems.reduce((sum, item) => sum + item.quantity, 0),
      };
    });

    res.status(201).json({
      success: true,
      message: "Order created successfully!",
      data: {
        orderId: result.order.id,
        totalAmount: result.order.total_amount,
        itemCount: result.itemCount,
        totalItems: result.totalItems,
        orderLines: result.orderLines,
      },
    });
  } catch (err) {
    console.error("Checkout error:", err.message);

    // Handle specific error types
    if (err.message.includes("No active cart")) {
      return res.status(404).json({
        success: false,
        error: err.message,
      });
    }

    if (err.message.includes("Cart is empty")) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }

    if (
      err.message.includes("Insufficient stock") ||
      err.message.includes("not available")
    ) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Something went wrong during checkout. Please try again.",
    });
  }
});

app.get("/account", getOptionalUser, async (req, res) => {
  const { userId } = req.user;
  if (!userId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required. Please sign in to access your account.",
    });
  }

  try {
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatar: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    return res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Account fetch error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch account details",
    });
  }
});

app.post("/logout", getOptionalUser, async (req, res) => {
  // Since JWT tokens are stateless, we just return success
  // The frontend should handle removing the token from storage
  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

// Export the app for Vercel to handle
module.exports = app;
